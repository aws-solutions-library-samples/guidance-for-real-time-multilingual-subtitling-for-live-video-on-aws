#!/bin/bash
apt-get update -y
apt-get install -y amazon-ssm-agent awscli
systemctl enable amazon-ssm-agent
systemctl start amazon-ssm-agent

# Install Node.js 20 (Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt-get install -y nodejs

# Install FFmpeg 6.x (latest static build)
wget -q https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar -xf ffmpeg-release-amd64-static.tar.xz
cp ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/
cp ffmpeg-*-amd64-static/ffprobe /usr/local/bin/
chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
rm -rf ffmpeg-*
# Ensure /usr/local/bin is in PATH
export PATH="/usr/local/bin:$PATH"
echo 'export PATH="/usr/local/bin:$PATH"' >> /etc/environment

# Verify installations
echo "=== Installation Verification ===" >> /var/log/userdata.log
node --version >> /var/log/userdata.log 2>&1 || echo "Node.js installation failed" >> /var/log/userdata.log
ffmpeg -version | head -1 >> /var/log/userdata.log 2>&1 || echo "FFmpeg installation failed" >> /var/log/userdata.log
aws --version >> /var/log/userdata.log 2>&1 || echo "AWS CLI installation failed" >> /var/log/userdata.log

# Create subtitle processor directory
mkdir -p /opt/subtitle-processor
cd /opt/subtitle-processor

npm init -y
npm install @aws-sdk/client-transcribe-streaming @aws-sdk/client-translate @aws-sdk/client-bedrock-runtime @aws-sdk/client-dynamodb @aws-sdk/util-utf8-node aws-sdk aws-signature-v4 bcrypt query-string utf8 websocket

# Start FFmpeg converter in background (5000 → 7950)
# nohup ffmpeg -i rtp://127.0.0.1:5000 -map 0:a -acodec libmp3lame -b:a 32k -ar 16000 -f mp3 udp://127.0.0.1:7950?localport=7949 > /var/log/ffmpeg-converter.log 2>&1 &

# CDK Asset will download the script file automatically
echo "Waiting for CDK Asset to download subtitle-processor.js..." >> /var/log/userdata.log

cat > /etc/systemd/system/subtitle-processor.service << 'SERVICE_EOF'
[Unit]
Description=Live Subtitle Processor
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/subtitle-processor
ExecStart=/usr/bin/node subtitle-processor.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=REGION=us-east-1
Environment=DYNAMODB_TABLE=SubtitleTable
Environment=LANGUAGE_CODE=en-US
Environment=ENABLE_TRANSLATION=true
Environment=SOURCE_LANGUAGE=en
Environment=CAPTION_LANGUAGES=en,hi,es,ko
Environment=VOCABULARY_NAME=custom-vocabulary


[Install]
WantedBy=multi-user.target
SERVICE_EOF

# Set proper permissions
chown -R ubuntu:ubuntu /opt/subtitle-processor

# UDP buffer for the system
sudo sysctl -w net.core.rmem_max=134217728
sudo sysctl -w net.core.rmem_default=134217728


echo "Bootstrap completed - CDK Asset will download script and start service" >> /var/log/userdata.log

