#!/bin/bash

# Trading API Installation Script
# This script sets up the trading server API in a fresh environment

set -e  # Exit on any error

echo "🚀 Starting Trading API Installation..."
echo "======================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   print_warning "Running as root. Some operations may require different handling."
fi

# Update system packages
print_status "Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

# Install curl and wget if not present
print_status "Installing essential tools..."
sudo apt-get install -y curl wget gnupg2 software-properties-common

# Install Node.js (using NodeSource repository for latest LTS)
print_status "Installing Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
    print_success "Node.js installed successfully"
else
    print_success "Node.js is already installed ($(node --version))"
fi

# Verify Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 14 ]; then
    print_error "Node.js version 14 or higher is required. Current version: $(node --version)"
    exit 1
fi

# Install PM2 globally
print_status "Installing PM2 process manager..."
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
    print_success "PM2 installed successfully"
else
    print_success "PM2 is already installed ($(pm2 --version))"
fi

# Navigate to project directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR"

print_status "Working in directory: $(pwd)"

# Install project dependencies
print_status "Installing project dependencies..."
npm install
print_success "Dependencies installed successfully"

# Create .env file from example if it doesn't exist
if [ ! -f ".env" ]; then
    print_status "Creating .env file from template..."
    cp .env.example .env
    print_success ".env file created"
    print_warning "Please review and update the .env file with your actual configuration"
else
    print_success ".env file already exists"
fi

# Configure firewall to open port 4444
print_status "Configuring firewall for port 4444..."
if command -v ufw &> /dev/null; then
    sudo ufw allow 4444/tcp
    print_success "Port 4444 opened in UFW firewall"
elif command -v firewall-cmd &> /dev/null; then
    sudo firewall-cmd --permanent --add-port=4444/tcp
    sudo firewall-cmd --reload
    print_success "Port 4444 opened in firewalld"
else
    print_warning "No recognized firewall found. You may need to manually open port 4444"
fi

# Create PM2 ecosystem file
print_status "Creating PM2 ecosystem configuration..."
cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'trading-api',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 4444
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};
EOF

# Create logs directory
mkdir -p logs

print_success "PM2 ecosystem configuration created"

# Start the application with PM2
print_status "Starting Trading API server with PM2..."
pm2 start ecosystem.config.js
pm2 save
pm2 startup

print_success "Trading API server started successfully!"

# Display status
echo ""
echo "======================================"
echo "🎉 Installation Complete!"
echo "======================================"
echo ""
print_status "Server Status:"
pm2 status
echo ""
print_status "Server is running on port 4444"
print_status "Logs location: ./logs/"
print_status "PM2 commands:"
echo "  - pm2 status          : Check server status"
echo "  - pm2 logs trading-api: View logs"
echo "  - pm2 restart trading-api: Restart server"
echo "  - pm2 stop trading-api: Stop server"
echo "  - pm2 delete trading-api: Remove from PM2"
echo ""
print_warning "Don't forget to:"
echo "  1. Review and update the .env file with your actual API keys"
echo "  2. Test the API endpoints"
echo "  3. Configure any additional security measures"
echo ""
print_success "Installation completed successfully! 🚀"