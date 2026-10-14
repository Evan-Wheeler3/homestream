# Watching away from home (optional)

Wheelhouse is built for your home network. Reaching it from outside is a separate decision with security
consequences, so it is off by default. **Do not simply forward a port on your router** — that puts your sign-in
page on the public internet.

## Recommended: Tailscale (private network, nothing exposed)

[Tailscale](https://tailscale.com) creates a private, encrypted network between _your own_ devices. Your movies
never pass through a third-party server in readable form, and nothing is opened on your router. The personal
plan is free.

1. Install Tailscale on the computer that runs Jellyfin + Wheelhouse, and on your phone/laptop.
   Sign in to the same Tailscale account on each.
2. On your phone (with Tailscale on), open `http://<computer-name>:8787` — the computer’s Tailscale name or
   `100.x.y.z` address is shown in the Tailscale app.
3. That’s it. Sign in with your Jellyfin account as usual.

**An address that never changes:** in the Tailscale admin console (_DNS_) leave **MagicDNS** on and rename the
computer to something short, e.g. `wheelhouse` (_Machines → … → Edit machine name_). Then
`http://wheelhouse:8787` works from any of your devices, at home or away, whatever Wi-Fi the computer is on.
Its `100.x.y.z` address doesn't change either.

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

and restart Wheelhouse. Open the `https://<computer>.<tailnet>.ts.net` address Tailscale prints. It stays
private to your tailnet (do **not** use `tailscale funnel`, which makes it public).

**Bandwidth:** away from home your upload speed is the limit. Set _Settings → Playback → Maximum streaming
quality_ to 4 Mbps or less on that device so Jellyfin sends a smaller stream (this needs transcoding, so enable
hardware acceleration in Jellyfin if you can).

## Working on the server from anywhere

Tailscale also lets you look after the Wheelhouse computer when you're out (say, someone at home puts discs in
while you watch the Discs page from work). With Tailscale on both devices:

- **See the screen:** on the Mac, _System Settings → General → Sharing → Screen Sharing_ on. From another Mac
  use Finder → _Go → Connect to Server_ → `vnc://wheelhouse`; from a phone use any VNC viewer (e.g. RealVNC
  Viewer) with the Mac's Tailscale name.
- **A terminal:** turn on _Sharing → Remote Login_ and connect with `ssh you@wheelhouse` (on a phone: an SSH
  app such as Termius). Handy commands, in the Wheelhouse folder: `git pull && npm ci && npm run build`, then
  `launchctl kickstart -k gui/$(id -u)/com.wheelhouse.app` to restart, and `tail -f /tmp/wheelhouse.log` to
  watch its log (macOS, with the supplied launchd file).
- **Updates without a terminal:** _Settings → Updates_ in Wheelhouse (when it was installed with `git clone`).
- **Claude Code:** run `claude remote-control` in the Wheelhouse folder on the Mac and pick the session up
  from the Claude app on your phone or at <https://claude.ai/code>.

Keep the Mac awake for all of this: _System Settings → Energy_ → _Prevent automatic sleeping when the display
is off_.

## Alternative: your own domain behind a reverse proxy (advanced)

Only if you understand the risks of exposing a service to the internet:

- Put Wheelhouse behind a reverse proxy that provides HTTPS (for example Caddy:
  `cinema.example.com { reverse_proxy 127.0.0.1:8787 }`).
- Set `TRUST_PROXY=true` and `COOKIE_SECURE=true`, and `HOST=127.0.0.1` so the app is only reachable through
  the proxy.
- Use strong, unique Jellyfin passwords for every account. Wheelhouse rate-limits sign-in attempts, but
  consider adding the proxy’s own access controls (IP allow-list, single sign-on) on top.
- Keep Node.js, Jellyfin and Wheelhouse up to date.

Jellyfin itself does not need to be exposed for any of this: Wheelhouse passes media through.
