# Run ffmpeg in infinite loop in order to self recovery
while :
do
  ffmpeg -loglevel quiet -re -i udp://127.0.0.1:7950 -vn -ac 1 -c:a pcm_s16le -ar 16000 -f wav - | node udp_audio_receiver.js
  sleep 3
done
