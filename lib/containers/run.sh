#!/bin/sh

# 환경 변수 설정
export TABLE_NAME=${TABLE_NAME:-"SubtitleTable"}
export VOCABULARY_NAME=${VOCABULARY_NAME:-"custom_vocabulary_uefa"}
export LANGUAGE_CODE=${LANGUAGE_CODE:-"de-DE"}
export UDP_PORT=${UDP_PORT:-7950}
export HTTP_PORT=${HTTP_PORT:-8080}
export AWS_REGION=${AWS_REGION:-"us-east-1"}

echo "Starting UDP Audio Receiver..."
echo "Table Name: $TABLE_NAME"
echo "Language Code: $LANGUAGE_CODE"
echo "UDP Port: $UDP_PORT"
echo "HTTP Port: $HTTP_PORT"
echo "AWS Region: $AWS_REGION"

# UDP 오디오 수신기 직접 실행
node udp_audio_receiver.js
