require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const app = express();
const PORT = process.env.PORT || 4444;
const FURY_API_URL = process.env.FURY_API_URL || 'https://de.fury.bot';
const FURY_API_KEY = process.env.FURY_API_KEY || '4b911db128185d547203dd27990384509f1bc18faeb01b722329fa60ba6c897e';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

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

      const response = await fetch(`${FURY_API_URL}/api/transactions/send`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          transactions: bundle.transactions
        }),
      });

      const data = await response.json();
      results.push(data.result || data);
      console.log(`Bundle ${i + 1} sent successfully`);
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

      // Prepare request for public API (using addresses instead of private keys)
      const publicApiRequest = {
        walletAddresses,
        tokenAddress,
        protocol,
        solAmount,
        ...(amounts && { amounts }),
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

      // Prepare request for public API (using addresses instead of private keys)
      const publicApiRequest = {
        walletAddresses,
        tokenAddress,
        protocol,
        ...(percentage !== undefined && { percentage }),
        ...(tokensAmount !== undefined && { tokensAmount }),
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
  console.log(`Health check: http://localhost:${PORT}/health`);
});