FROM node:lts-alpine

# create the application directory
RUN mkdir /udp_audio_receiver
WORKDIR /udp_audio_receiver

# Install Build Dependencies for the docker image
RUN apk add --no-cache --virtual .gyp \
        make \
        g++ \
        ffmpeg

# prepare application dependencies
COPY package.json ./

# install application dependencies
RUN npm install

# copy the application files
COPY udp_audio_receiver.js run.sh ./

RUN ["chmod", "+x", "run.sh"]

# Expose the port for UDP
EXPOSE 7950/udp

# run it when the container starts -- includes ffmpeg audio conversion -- requires environment vars
CMD sh run.sh