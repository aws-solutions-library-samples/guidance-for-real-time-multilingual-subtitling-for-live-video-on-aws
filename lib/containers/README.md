## For local development:

```
nano dev.env
```

```
docker build -t udp_audio_receiver:v0.1 .
```

```
docker run --env-file dev.env -p 7950:7950/udp udp_audio_receiver:v0.1
```

```
ffmpeg -re -stream_loop -1 -i uefa_barcelona_frankfurt_lowres.mp4 -f mpegts udp://127.0.0.1:7950
```