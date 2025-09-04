<p align="center">

  <img src="https://img.shields.io/badge/Built%20on-Solana-3a0ca3?style=for-the-badge&logo=solana" alt="Built on Solana" />
  <img src="https://img.shields.io/badge/Open%20Source-Yes-00b386?style=for-the-badge&logo=github" alt="Open Source" />

</p>

# ⚡ Selfhosted Solana Trading API

A self-hosted **Express.js API server** for automated Solana token trading powered by the [**Fury Bot**](https://fury.bot) service.  
It provides endpoints for buying and selling tokens with **multi-wallet support**, **transaction bundling**, and built-in security features.

---

## ✨ Features

- 💸 **Token Trading** – Buy and sell Solana tokens via Fury Bot API  
- 👛 **Multi-Wallet Support** – Manage and trade from multiple wallets simultaneously  
- 📦 **Transaction Bundling** – Batch transactions for better performance  
- 🚦 **Rate Limiting** – Prevent API abuse with built-in throttling  
- 🌐 **CORS Enabled** – Cross-origin requests supported  
- 🛡️ **Error Handling** – Comprehensive logging and error management  

---

## 📚 Prerequisites

- [Node.js](https://nodejs.org/) (v14 or higher)  
- [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)  
- Solana wallet private keys  
- Fury Bot API access  

---

## 🚀 Getting Started

### Installation

```bash
git clone <repository-url>
cd selfhosted-api
npm install
```

### Configuration

Set environment variables in `.env` or update `server.js`:

- `FURY_API_URL` → Fury Bot API endpoint (default: `https://de.fury.bot`)  
- `FURY_API_KEY` → Your Fury Bot API key  
- `PORT` → Server port (default: `4444`)  

### Run the Server

```bash
npm start
```

The server will be available at:  
👉 `http://localhost:4444`

---

## 🔌 API Endpoints

### `POST /api/tokens/buy`

Buy tokens with specified parameters.  

**Request body:**
```json
{
  "tokenAddress": "string",
  "amount": "number",
  "walletPrivateKeys": ["string"],
  "slippage": "number (optional, default: 10)",
  "priorityFee": "number (optional)"
}
```

---

### `POST /api/tokens/sell`

Sell tokens with specified parameters.  

**Request body:**
```json
{
  "tokenAddress": "string",
  "percentage": "number (1-100)",
  "walletPrivateKeys": ["string"],
  "slippage": "number (optional, default: 10)",
  "priorityFee": "number (optional)"
}
```

---

## 🚦 Rate Limiting

- ⏱ **Max 2 bundles per second**  
- 🔒 Automatic throttling when limits are exceeded  

---

## 🔐 Security Notes

⚠️ **Important:**  
1. Never commit **private keys** to version control  
2. Keep your **Fury Bot API key** secret  
3. Run only in a **secure network environment**  
4. Enforce **access control** in production  

---

## 🛠 Dependencies

- [express](https://expressjs.com/) – Web framework  
- [cors](https://www.npmjs.com/package/cors) – Cross-origin middleware  
- [@solana/web3.js](https://solana-labs.github.io/solana-web3.js/) – Solana SDK  
- [bs58](https://www.npmjs.com/package/bs58) – Base58 encoder/decoder  

---

## 🧑‍💻 Development

### Run in Dev Mode
```bash
npm run dev
```

### Run Tests
```bash
npm test
```

---

## 🤝 Contributing

Contributions are welcome!  
1. Fork the repo  
2. Create a feature branch  
3. Implement your changes  
4. Add tests if relevant  
5. Open a pull request  

---

## 📄 License

Licensed under the [MIT License](LICENSE).  

---

## ⚠️ Disclaimer

This software is for **educational and development purposes only**.  
Use at your own risk and **always test before real-world use**.  

---

## 💬 Support

For issues and questions, please open a GitHub Issue.  
