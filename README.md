MoodWave is a Navidrome client for generating ai playlist very easily.

---------------------------------------------------------------------------- 

 MoodWave can connect to your Navidrome server and your local ollama server 
 to generate playlists based off your library.  
 ------------------------------------------------------------------------------






You can tell ai anything and it will build you the perfect playlist based off your library. 
<img width="1919" height="938" alt="1" src="https://github.com/user-attachments/assets/e8f0829d-a179-4950-b4f0-ee41668fc67c" />
-----------------------------------------------------------------------------------------------------------------------------------
Set up daily playlist so that ai can generate you a new playlist everyday based off what you listen to and your playlist's.
<img width="1919" height="934" alt="2" src="https://github.com/user-attachments/assets/85a3ce01-9404-4faa-bef2-caefe54986aa" />

-----------------------------------------------------------------------------------------------------------------------------------------


Deploy using dock



## Docker Compose

```yaml
services:
  moodwave:
    build: https://github.com/theflossingman/moodwave.git#main
    ports:
      - "9091:3002"
    volumes:
      - /your/path/moodwave:/app/data
    environment:
      TZ: America/New_York
      NODE_ENV: production
      PORT: 3002
    restart: unless-stopped
```
