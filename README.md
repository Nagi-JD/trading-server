# Selfhosted Solana Trading API

A self-hosted Express.js API server for automated Solana token trading using the Fury Bot service. This API provides endpoints for buying and selling tokens with support for multiple wallets and transaction bundling.

## Features

- **Token Trading**: Buy and sell Solana tokens through Fury Bot API
- **Multi-wallet Support**: Handle multiple wallets simultaneously
- **Transaction Bundling**: Efficient transaction batching for better performance
- **Rate Limiting**: Built-in rate limiting to prevent API abuse
- **CORS Support**: Cross-origin resource sharing enabled
- **Error Handling**: Comprehensive error handling and logging

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Solana wallet private keys
- Fury Bot API access

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd selfhosted-api
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables (see Configuration section)

4. Start the server:
```bash
npm start
```

The server will start on port 4444 by default.

## Configuration

Update the following constants in `server.js` or use environment variables:

- `FURY_API_URL`: Fury Bot API endpoint (default: https://de.fury.bot)
- `FURY_API_KEY`: Your Fury Bot API key for user rewards
- `PORT`: Server port (default: 4444)

## API Endpoints

### POST /api/tokens/buy

Buy tokens with specified parameters.

**Request Body:**
```json
{
  "tokenAddress": "string",
  "amount": "number",
  "walletPrivateKeys": ["string"],
  "slippage": "number (optional, default: 10)",
  "priorityFee": "number (optional)"
}
```

### POST /api/tokens/sell

Sell tokens with specified parameters.

**Request Body:**
```json
{
  "tokenAddress": "string",
  "percentage": "number (1-100)",
  "walletPrivateKeys": ["string"],
  "slippage": "number (optional, default: 10)",
  "priorityFee": "number (optional)"
}
```

## Rate Limiting

The API includes built-in rate limiting:
- Maximum 2 bundles per second
- Automatic throttling when limits are exceeded

## Security Considerations

⚠️ **Important Security Notes:**

1. **Private Keys**: Never commit private keys to version control
2. **API Keys**: Keep your Fury Bot API key secure
3. **Network**: Run on a secure network environment
4. **Access Control**: Implement proper access controls for production use

## Dependencies

- `express`: Web framework for Node.js
- `cors`: Cross-origin resource sharing middleware
- `@solana/web3.js`: Solana JavaScript SDK
- `bs58`: Base58 encoding/decoding

## Development

### Running in Development Mode

```bash
npm run dev
```

### Testing

```bash
npm test
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Disclaimer

This software is for educational and development purposes. Use at your own risk. Always test thoroughly before using in real scenarios.

## Support

For issues and questions, please open an issue on GitHub.