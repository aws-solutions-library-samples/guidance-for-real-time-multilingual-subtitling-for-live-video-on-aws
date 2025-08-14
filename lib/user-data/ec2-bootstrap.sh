#!/bin/bash
dnf update -y
dnf install -y amazon-ssm-agent
systemctl enable amazon-ssm-agent
systemctl start amazon-ssm-agent

# Install Node.js 20 (Amazon Linux 2023)
dnf install -y nodejs20 npm
ln -sf /usr/bin/node-20 /usr/bin/node
ln -sf /usr/bin/npm-20 /usr/bin/npm

# Install FFmpeg using static binary (Amazon Linux 2023 doesn't have FFmpeg in repos)
cd /tmp
wget -q https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar -xf ffmpeg-release-amd64-static.tar.xz
cd ffmpeg-*-amd64-static
cp ffmpeg /usr/local/bin/
cp ffprobe /usr/local/bin/
chmod +x /usr/local/bin/ffmpeg
chmod +x /usr/local/bin/ffprobe

# Create symlinks for easier access
ln -sf /usr/local/bin/ffmpeg /usr/bin/ffmpeg
ln -sf /usr/local/bin/ffprobe /usr/bin/ffprobe

# Verify installations
echo "=== Installation Verification ===" >> /var/log/userdata.log
node --version >> /var/log/userdata.log 2>&1 || echo "Node.js installation failed" >> /var/log/userdata.log
ffmpeg -version | head -1 >> /var/log/userdata.log 2>&1 || echo "FFmpeg installation failed" >> /var/log/userdata.log

# Create subtitle processor directory
mkdir -p /opt/subtitle-processor
cd /opt/subtitle-processor

npm init -y
npm install @aws-sdk/client-transcribe-streaming @aws-sdk/client-translate @aws-sdk/util-utf8-node aws-sdk

# Start FFmpeg converter in background (5000 → 7950)
nohup ffmpeg -i rtp://127.0.0.1:5000 -map 0:a -acodec libmp3lame -b:a 32k -ar 16000 -f mp3 udp://127.0.0.1:7950?localport=7949 > /var/log/ffmpeg-converter.log 2>&1 &

dnf install -y git

# Clone repository and copy the script
git clone https://github.com/Taehooon6476/live-subtitle.git temp-repo
cp temp-repo/IBC2025_Subtitle_v1.js subtitle-processor.js
rm -rf temp-repo

cat > /etc/systemd/system/subtitle-processor.service << 'SERVICE_EOF'
[Unit]
Description=Live Subtitle Processor
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/opt/subtitle-processor
ExecStart=/usr/bin/node subtitle-processor.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=REGION=us-east-1
Environment=TABLE_NAME=SubtitleTable
Environment=ID_PIPE=pipe0
Environment=LANGUAGE_CODE=en-US
Environment=ENABLE_TRANSLATION=true
Environment=SOURCE_LANGUAGE=en
Environment=CAPTION_LANGUAGES=en,hi,es,ko,de

[Install]
WantedBy=multi-user.target
SERVICE_EOF

# Set proper permissions
chown -R ec2-user:ec2-user /opt/subtitle-processor
chmod +x /opt/subtitle-processor/subtitle-processor.js

# Reload systemd and enable service
systemctl daemon-reload
systemctl enable subtitle-processor
systemctl start subtitle-processor

echo "=== Service Status ===" >> /var/log/userdata.log
systemctl status subtitle-processor >> /var/log/userdata.log 2>&1

echo "UserData script completed successfully" >> /var/log/userdata.log

