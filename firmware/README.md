# ESP8266 Firmware Structure

The ESP8266 is a peripheral terminal only. It should detect coins, drive display/audio/LED feedback, call the router's local API, and retry failed events locally.

Target layout:

```text
firmware/
├── main.ino
├── coin/
├── display/
├── audio/
├── api/
├── storage/
├── config/
└── ota/
```

Keep these out of ESP firmware:

- voucher database
- session computation
- hotspot authorization logic
- cloud API keys

Preferred router call:

```text
GET http://10.0.0.1:2080/cgi-bin/icxifi/api/v1/coin?amount=5&deviceId=vendo-1&clientIp=10.0.0.123
```

The legacy sketch remains under `router/esp8266/` until it is split into this structure.
