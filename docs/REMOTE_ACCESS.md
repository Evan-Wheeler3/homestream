# Watching away from home (optional)

Private Cinema is built for your home network. Reaching it from outside is a separate decision with security
consequences, so it is off by default. **Do not simply forward a port on your router** — that puts your sign-in
page on the public internet.

## Recommended: Tailscale (private network, nothing exposed)

[Tailscale](https://tailscale.com) creates a private, encrypted network between _your own_ devices. Your movies
never pass through a third-party server in readable form, and nothing is opened on your router. The personal
plan is free.

1. Install Tailscale on the computer that runs Jellyfin + Private Cinema, and on your phone/laptop.
   Sign in to the same Tailscale account on each.
2. On your phone (with Tailscale on), open `http://<computer-name>:8787` — the computer’s Tailscale name or
   `100.x.y.z` address is shown in the Tailscale app.
3. That’s it. Sign in with your Jellyfin account as usual.

### Optional: HTTPS with Tailscale Serve

For a proper `https://` address (and Secure cookies), let Tailscale terminate HTTPS:

```bash
tailscale serve --bg 8787
```

Then in `.env` set:

```
TRUST_PROXY=true
COOKIE_SECURE=auto
```

and restart Private Cinema. Open the `https://<computer>.<tailnet>.ts.net` address Tailscale prints. It stays
private to your tailnet (do **not** use `tailscale funnel`, which makes it public).

**Bandwidth:** away from home your upload speed is the limit. Set _Settings → Playback → Maximum streaming
quality_ to 4 Mbps or less on that device so Jellyfin sends a smaller stream (this needs transcoding, so enable
hardware acceleration in Jellyfin if you can).

## Alternative: your own domain behind a reverse proxy (advanced)

Only if you understand the risks of exposing a service to the internet:

- Put Private Cinema behind a reverse proxy that provides HTTPS (for example Caddy:
  `cinema.example.com { reverse_proxy 127.0.0.1:8787 }`).
- Set `TRUST_PROXY=true` and `COOKIE_SECURE=true`, and `HOST=127.0.0.1` so the app is only reachable through
  the proxy.
- Use strong, unique Jellyfin passwords for every account. Private Cinema rate-limits sign-in attempts, but
  consider adding the proxy’s own access controls (IP allow-list, single sign-on) on top.
- Keep Node.js, Jellyfin and Private Cinema up to date.

Jellyfin itself does not need to be exposed for any of this: Private Cinema passes media through.
