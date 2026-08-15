require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const app = express();
const PORT = process.env.PORT || 4444;
const FURY_API_URL = process.env.FURY_API_URL || 'https://de.fury.bot';
// SECURITY: never hardcode a real key. Provide FURY_API_KEY via the environment
// (.env is git-ignored). This falls back to empty so a missing key fails loudly
// instead of shipping a committed secret.
const FURY_API_KEY = process.env.FURY_API_KEY || '';

// ---------------------------------------------------------------------------
// Execution provider abstraction (transaction landing)
//
// Decouples "who lands the signed transactions" from the trading logic.
// Supports Helius Sender, Jito, and Jupiter (tx.jup.ag), with Fury preserved
// as an optional fallback.
// Configure via env:
//   EXECUTION_PROVIDER   primary: fury | helius-sender | jito | jupiter   (default: fury)
//   EXECUTION_FALLBACKS  comma-separated ordered fallbacks                 (default: fury)
//   HELIUS_SENDER_URL    default https://sender.helius-rpc.com/fast
//   HELIUS_API_KEY       optional for Sender
//   JITO_ENDPOINT        default https://mainnet.block-engine.jito.wtf
//   JUPITER_ENDPOINT     default https://tx.jup.ag
//   JUPITER_API_KEY      required by tx.jup.ag (x-api-key header)
// ---------------------------------------------------------------------------
const EXECUTION_PROVIDER = process.env.EXECUTION_PROVIDER || 'fury';
const EXECUTION_FALLBACKS = (process.env.EXECUTION_FALLBACKS || 'fury')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const HELIUS_SENDER_URL = process.env.HELIUS_SENDER_URL || 'https://sender.helius-rpc.com/fast';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const JITO_ENDPOINT = process.env.JITO_ENDPOINT || 'https://mainnet.block-engine.jito.wtf';
const JUPITER_ENDPOINT = process.env.JUPITER_ENDPOINT || 'https://tx.jup.ag';
// SECURITY: never hardcode a real key. Required by tx.jup.ag's x-api-key header.
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';

const solanaTrackerFeed = require('./solanaTrackerFeed');

// Ordered, de-duplicated provider chain: [primary, ...fallbacks].
const providerChain = [EXECUTION_PROVIDER, ...EXECUTION_FALLBACKS].filter(
  (p, i, arr) => arr.indexOf(p) === i,
);

// Build the HTTP request for a provider given base58-encoded signed transactions.
const planProviderRequest = (provider, transactions) => {
  switch (provider) {
    case 'fury':
      return {
        url: `${FURY_API_URL}/api/transactions/send`,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transactions }),
        },
      };
    case 'jito': {
      const single = transactions.length === 1;
      return {
        url: `${JITO_ENDPOINT}/api/v1/${single ? 'transactions' : 'bundles'}`,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: single ? 'sendTransaction' : 'sendBundle',
            params: single
              ? [transactions[0], { encoding: 'base58' }]
              : [transactions, { encoding: 'base58' }],
          }),
        },
      };
    }
    case 'helius-sender':
      // Sender lands single transactions; the caller loops per tx.
      return {
        url: HELIUS_API_KEY ? `${HELIUS_SENDER_URL}?api-key=${HELIUS_API_KEY}` : HELIUS_SENDER_URL,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params: [transactions[0], { encoding: 'base58', skipPreflight: true, maxRetries: 0 }],
          }),
        },
      };
    case 'jupiter': {
      // tx.jup.ag lands single transactions only (no bundle equivalent) and
      // requires: (1) an x-api-key header, (2) base64 encoding only, and
      // (3) the signed tx must already carry a Jupiter tip instruction.
      if (!JUPITER_API_KEY) throw new Error('jupiter provider requires JUPITER_API_KEY');
      const base64Tx = Buffer.from(bs58.decode(transactions[0])).toString('base64');
      return {
        url: JUPITER_ENDPOINT,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': JUPITER_API_KEY },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params: [base64Tx, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
          }),
        },
      };
    }
    default:
      throw new Error(`Unknown execution provider: ${provider}`);
  }
};

// Send one bundle's transactions via the provider chain, trying fallbacks on failure.
const sendBundleViaProviders = async (transactions) => {
  const failures = [];
  for (const provider of providerChain) {
    try {
      // Helius Sender and Jupiter (tx.jup.ag) are single-tx: send each and collect results.
      const txGroups = provider === 'helius-sender' || provider === 'jupiter'
        ? transactions.map((tx) => [tx])
        : [transactions];

      const results = [];
      for (const group of txGroups) {
        const { url, options } = planProviderRequest(provider, group);
        const response = await fetch(url, options);
        const data = await response.json();
        if (data && (data.error || data.success === false)) {
          const msg = data.error && data.error.message ? data.error.message : (data.error || 'provider error');
          throw new Error(typeof msg === 'string' ? msg : 'provider error');
        }
        results.push(data.result || data);
      }
      return { provider, result: results.length === 1 ? results[0] : results };
    } catch (err) {
      failures.push(`${provider}: ${err.message}`);
      console.warn(`Provider ${provider} failed, trying next:`, err.message);
    }
  }
  throw new Error(`All execution providers failed (${providerChain.join(' -> ')}): ${failures.join('; ')}`);
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check for the frontend's server-discovery/ping logic
// (solana-ui's pingHealthyServer expects 200 + { status: "healthy" }).
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Live token feed (Creations / Migrations), backed by Solana Tracker.
// See solanaTrackerFeed.js for the polling/caching implementation.
app.get('/api/feed/creations', (req, res) => {
  res.json(solanaTrackerFeed.getFeedSnapshot('creations'));
});
app.get('/api/feed/graduating', (req, res) => {
  res.json(solanaTrackerFeed.getFeedSnapshot('graduating'));
});
app.get('/api/feed/graduated', (req, res) => {
  res.json(solanaTrackerFeed.getFeedSnapshot('graduated'));
});

// Rate limiting state
const rateLimitState = {
  count: 0,
  lastReset: Date.now(),
  maxBundlesPerSecond: parseInt(process.env.MAX_BUNDLES_PER_SECOND) || 2
};

// Check rate limit
const checkRateLimit = async () => {
  const now = Date.now();
  
  if (now - rateLimitState.lastReset >= 1000) {
    rateLimitState.count = 0;
    rateLimitState.lastReset = now;
  }
  
  if (rateLimitState.count >= rateLimitState.maxBundlesPerSecond) {
    const waitTime = 1000 - (now - rateLimitState.lastReset);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    rateLimitState.count = 0;
    rateLimitState.lastReset = Date.now();
  }
  
  rateLimitState.count++;
};

// Create keypairs from private keys
const createKeypairs = (privateKeys) => {
  return privateKeys.map(privateKey => {
    try {
      return Keypair.fromSecretKey(bs58.decode(privateKey));
    } catch (error) {
      console.error('Error creating keypair:', error);
      throw new Error(`Invalid private key format`);
    }
  });
};

// Sign a bundle of transactions
const signTransactionBundle = (transactions, walletKeypairs) => {
  if (!transactions || !Array.isArray(transactions)) {
    console.error("Invalid transactions array");
    return [];
  }

  const signedTransactions = transactions.map(txBase58 => {
    if (!txBase58) {
      console.warn(`Transaction is null or undefined`);
      return null;
    }

    try {
      // Deserialize transaction
      const txBuffer = bs58.decode(txBase58);
      const transaction = VersionedTransaction.deserialize(txBuffer);
      
      // Extract required signers from staticAccountKeys
      const signers = [];
      for (const accountKey of transaction.message.staticAccountKeys) {
        const pubkeyStr = accountKey.toBase58();
        const matchingKeypair = walletKeypairs.find(
          kp => kp.publicKey.toBase58() === pubkeyStr
        );
        if (matchingKeypair && !signers.includes(matchingKeypair)) {
          signers.push(matchingKeypair);
        }
      }
      
      if (signers.length === 0) {
        console.warn(`No matching signers found for transaction`);
        return null;
      }
      
      // Sign the transaction
      transaction.sign(signers);
      
      // Serialize and encode the fully signed transaction
      return bs58.encode(transaction.serialize());
    } catch (error) {
      console.error(`Error signing transaction:`, error);
      return null;
    }
  }).filter(tx => tx !== null);
  
  return signedTransactions;
};

// Split wallets into chunks of maximum 5 wallets each
const chunkWallets = (walletPrivateKeys, chunkSize = 5) => {
  const chunks = [];
  for (let i = 0; i < walletPrivateKeys.length; i += chunkSize) {
    chunks.push(walletPrivateKeys.slice(i, i + chunkSize));
  }
  return chunks;
};

// Split bundles to ensure each has at most 5 transactions
const splitLargeBundles = (bundles) => {
  const MAX_TRANSACTIONS_PER_BUNDLE = 5;
  const result = [];
  
  for (const bundle of bundles) {
    if (!bundle.transactions || !Array.isArray(bundle.transactions)) {
      continue;
    }
    
    if (bundle.transactions.length <= MAX_TRANSACTIONS_PER_BUNDLE) {
      result.push(bundle);
    } else {
      for (let i = 0; i < bundle.transactions.length; i += MAX_TRANSACTIONS_PER_BUNDLE) {
        const chunkTransactions = bundle.transactions.slice(i, i + MAX_TRANSACTIONS_PER_BUNDLE);
        result.push({ transactions: chunkTransactions });
      }
    }
  }
  
  return result;
};

// Send signed bundles to the public API
const sendBundles = async (signedBundles) => {
  const results = [];
  
  for (let i = 0; i < signedBundles.length; i++) {
    const bundle = signedBundles[i];
    
    if (!bundle.transactions || bundle.transactions.length === 0) {
      continue;
    }

    try {
      // Add delay between bundles to respect rate limits
      await new Promise(resolve => setTimeout(resolve, i * 100));
      await checkRateLimit();

      // Route via the configured execution-provider chain (Helius Sender / Jito
      // / Fury), falling back through the chain on failure.
      const { provider, result } = await sendBundleViaProviders(bundle.transactions);
      results.push(result);
      console.log(`Bundle ${i + 1} sent successfully via ${provider}`);
    } catch (error) {
      console.error(`Error sending bundle ${i + 1}:`, error);
      results.push({ error: error.message });
    }
  }
  
  return results;
};

// Buy endpoint - handles token purchases
app.post('/api/tokens/buy', async (req, res) => {
  try {
    const { 
      walletPrivateKeys,
      tokenAddress,
      protocol,
      solAmount,
      amounts,
      slippageBps,
      jitoTipLamports,
      telegram
    } = req.body;

    if (!walletPrivateKeys || !Array.isArray(walletPrivateKeys)) {
      return res.status(400).json({ 
        success: false, 
        error: 'walletPrivateKeys array is required' 
      });
    }

    if (!tokenAddress || !protocol || !solAmount) {
      return res.status(400).json({ 
        success: false, 
        error: 'tokenAddress, protocol, and solAmount are required' 
      });
    }

    console.log(`Buy request: ${walletPrivateKeys.length} wallets, ${solAmount} SOL, ${protocol} protocol`);

    // Split wallets into chunks of 5 if more than 5 wallets
    const walletChunks = chunkWallets(walletPrivateKeys, 5);
    console.log(`Processing ${walletChunks.length} wallet chunks`);

    let allSignedBundles = [];
    let allSendResults = [];

    // Process each wallet chunk
    for (let chunkIndex = 0; chunkIndex < walletChunks.length; chunkIndex++) {
      const walletChunk = walletChunks[chunkIndex];
      console.log(`Processing chunk ${chunkIndex + 1}/${walletChunks.length} with ${walletChunk.length} wallets`);

      // Create keypairs from private keys for this chunk
      const walletKeypairs = createKeypairs(walletChunk);
      const walletAddresses = walletKeypairs.map(kp => kp.publicKey.toBase58());

      // Per-wallet amounts must be sliced to match THIS chunk's wallets, not
      // broadcast whole. Otherwise chunk 2+ would receive amounts meant for
      // chunk 1's wallets (misaligned allocation).
      const chunkStart = chunkIndex * 5;
      const chunkAmounts = Array.isArray(amounts)
        ? amounts.slice(chunkStart, chunkStart + walletChunk.length)
        : undefined;

      // Prepare request for public API (using addresses instead of private keys)
      const publicApiRequest = {
        walletAddresses,
        tokenAddress,
        protocol,
        solAmount,
        ...(chunkAmounts && { amounts: chunkAmounts }),
        ...(slippageBps !== undefined && { slippageBps }),
        ...(jitoTipLamports !== undefined && { jitoTipLamports }),
        ...(telegram && { telegram })
      };

      // Get unsigned transactions from public API
      const response = await fetch(`${FURY_API_URL}/api/tokens/buy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': FURY_API_KEY
        },
        body: JSON.stringify(publicApiRequest)
      });

      if (!response.ok) {
        const errorData = await response.json();
        return res.status(response.status).json({ 
          success: false, 
          error: errorData.error || `HTTP error! Status: ${response.status}` 
        });
      }

      const data = await response.json();
      
      if (!data.success) {
        return res.status(400).json({ 
          success: false, 
          error: data.error || 'Failed to get unsigned transactions' 
        });
      }

      // Parse bundles from response
      let bundles = [];
      if (data.bundles && Array.isArray(data.bundles)) {
        bundles = data.bundles.map(bundle =>
          Array.isArray(bundle) ? { transactions: bundle } : bundle
        );
      } else if (data.transactions && Array.isArray(data.transactions)) {
        bundles = [{ transactions: data.transactions }];
      } else if (data.data && data.data.transactions && Array.isArray(data.data.transactions)) {
        bundles = [{ transactions: data.data.transactions }];
      } else if (Array.isArray(data)) {
        bundles = [{ transactions: data }];
      } else {
        return res.status(400).json({ 
          success: false, 
          error: 'No transactions returned from public API' 
        });
      }

      // Split large bundles and sign them
      const splitBundles = splitLargeBundles(bundles);
      const signedBundles = splitBundles.map(bundle => ({
        transactions: signTransactionBundle(bundle.transactions, walletKeypairs)
      })).filter(bundle => bundle.transactions.length > 0);

      if (signedBundles.length === 0) {
        console.warn(`No signed bundles for chunk ${chunkIndex + 1}`);
        continue;
      }

      console.log(`Signed ${signedBundles.length} bundles for chunk ${chunkIndex + 1}, sending to network...`);

      // Send signed bundles for this chunk
      const sendResults = await sendBundles(signedBundles);
      
      allSignedBundles.push(...signedBundles);
      allSendResults.push(...sendResults);

      // Add delay between chunks to avoid overwhelming the API
      if (chunkIndex < walletChunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    if (allSignedBundles.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Failed to sign any transactions' 
      });
    }

    res.json({
      success: true,
      data: {
        walletChunksProcessed: walletChunks.length,
        bundlesSent: allSignedBundles.length,
        results: allSendResults
      }
    });

  } catch (error) {
    console.error('Buy endpoint error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Internal server error' 
    });
  }
});

// Sell endpoint - handles token sales
app.post('/api/tokens/sell', async (req, res) => {
  try {
    const { 
      walletPrivateKeys,
      tokenAddress,
      protocol,
      percentage,
      tokensAmount,
      slippageBps,
      outputMint,
      jitoTipLamports,
      telegram
    } = req.body;

    if (!walletPrivateKeys || !Array.isArray(walletPrivateKeys)) {
      return res.status(400).json({ 
        success: false, 
        error: 'walletPrivateKeys array is required' 
      });
    }

    if (!tokenAddress || !protocol) {
      return res.status(400).json({ 
        success: false, 
        error: 'tokenAddress and protocol are required' 
      });
    }

    if (!percentage && !tokensAmount) {
      return res.status(400).json({ 
        success: false, 
        error: 'Either percentage or tokensAmount is required' 
      });
    }

    console.log(`Sell request: ${walletPrivateKeys.length} wallets, ${percentage || tokensAmount}, ${protocol} protocol`);

    // Split wallets into chunks of 5 if more than 5 wallets
    const walletChunks = chunkWallets(walletPrivateKeys, 5);
    console.log(`Processing ${walletChunks.length} wallet chunks`);

    let allSignedBundles = [];
    let allSendResults = [];

    // Process each wallet chunk
    for (let chunkIndex = 0; chunkIndex < walletChunks.length; chunkIndex++) {
      const walletChunk = walletChunks[chunkIndex];
      console.log(`Processing chunk ${chunkIndex + 1}/${walletChunks.length} with ${walletChunk.length} wallets`);

      // Create keypairs from private keys for this chunk
      const walletKeypairs = createKeypairs(walletChunk);
      const walletAddresses = walletKeypairs.map(kp => kp.publicKey.toBase58());

      // Per-wallet token amounts must be sliced to THIS chunk's wallets when an
      // array is provided; a scalar tokensAmount applies to every wallet as-is.
      const chunkStart = chunkIndex * 5;
      const chunkTokensAmount = Array.isArray(tokensAmount)
        ? tokensAmount.slice(chunkStart, chunkStart + walletChunk.length)
        : tokensAmount;

      // Prepare request for public API (using addresses instead of private keys)
      const publicApiRequest = {
        walletAddresses,
        tokenAddress,
        protocol,
        ...(percentage !== undefined && { percentage }),
        ...(chunkTokensAmount !== undefined && { tokensAmount: chunkTokensAmount }),
        ...(slippageBps !== undefined && { slippageBps }),
        ...(outputMint && { outputMint }),
        ...(jitoTipLamports !== undefined && { jitoTipLamports }),
        ...(telegram && { telegram })
      };

      // Get unsigned transactions from public API
      const response = await fetch(`${FURY_API_URL}/api/tokens/sell`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': FURY_API_KEY
        },
        body: JSON.stringify(publicApiRequest)
      });

      if (!response.ok) {
        const errorData = await response.json();
        return res.status(response.status).json({ 
          success: false, 
          error: errorData.error || `HTTP error! Status: ${response.status}` 
        });
      }

      const data = await response.json();
      
      if (!data.success) {
        return res.status(400).json({ 
          success: false, 
          error: data.error || 'Failed to get unsigned transactions' 
        });
      }

      // Parse bundles from response
      let bundles = [];
      if (data.bundles && Array.isArray(data.bundles)) {
        bundles = data.bundles.map(bundle =>
          Array.isArray(bundle) ? { transactions: bundle } : bundle
        );
      } else if (data.transactions && Array.isArray(data.transactions)) {
        bundles = [{ transactions: data.transactions }];
      } else if (Array.isArray(data)) {
        bundles = [{ transactions: data }];
      } else {
        return res.status(400).json({ 
          success: false, 
          error: 'No transactions returned from public API' 
        });
      }

      // Split large bundles and sign them
      const splitBundles = splitLargeBundles(bundles);
      const signedBundles = splitBundles.map(bundle => ({
        transactions: signTransactionBundle(bundle.transactions, walletKeypairs)
      })).filter(bundle => bundle.transactions.length > 0);

      if (signedBundles.length === 0) {
        console.warn(`No signed bundles for chunk ${chunkIndex + 1}`);
        continue;
      }

      console.log(`Signed ${signedBundles.length} bundles for chunk ${chunkIndex + 1}, sending to network...`);

      // Send signed bundles for this chunk
      const sendResults = await sendBundles(signedBundles);
      
      allSignedBundles.push(...signedBundles);
      allSendResults.push(...sendResults);

      // Add delay between chunks to avoid overwhelming the API
       if (chunkIndex < walletChunks.length - 1) {
         await new Promise(resolve => setTimeout(resolve, 200));
       }
    }

    if (allSignedBundles.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Failed to sign any transactions' 
      });
    }

    res.json({
      success: true,
      data: {
        walletChunksProcessed: walletChunks.length,
        bundlesSent: allSignedBundles.length,
        results: allSendResults
      }
    });

  } catch (error) {
    console.error('Sell endpoint error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Internal server error' 
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error' 
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Self-hosted trading API server running on port ${PORT}`);
  console.log(`Public API: ${FURY_API_URL}`);
  solanaTrackerFeed.startPolling();
});