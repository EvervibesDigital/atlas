# Chat with ATLAS from the road — atlas.evervibesdigital.com

This exposes the **real** ATLAS running on your laptop (full memory, agents,
businesses) at `https://atlas.evervibesdigital.com`, through a free Cloudflare
Tunnel. The panel stays bound to `localhost` — the tunnel is the only ingress,
and it's still protected by your master password (now with brute-force lockout).

## One-time setup (~10 minutes)

You need the `evervibesdigital.com` domain on Cloudflare (it already is).

1. **Install cloudflared** (the tunnel client):
   - Download the Windows installer from
     https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
   - Or with winget: `winget install --id Cloudflare.cloudflared`

2. **Log in** (opens a browser — pick the evervibesdigital.com zone):
   ```
   cloudflared tunnel login
   ```

3. **Create the tunnel:**
   ```
   cloudflared tunnel create atlas
   ```
   Note the **Tunnel ID** and the credentials file path it prints
   (`C:\Users\<you>\.cloudflared\<ID>.json`).

4. **Add the config:** copy `remote/cloudflared-config.example.yml` to
   `C:\Users\<you>\.cloudflared\config.yml` and put your Tunnel ID in the
   `credentials-file` path.

5. **Route the subdomain:**
   ```
   cloudflared tunnel route dns atlas atlas.evervibesdigital.com
   ```

6. **Run it:** double-click `remote\Start-ATLAS-Remote.bat` (starts the panel +
   the tunnel). On your phone, open `https://atlas.evervibesdigital.com`,
   unlock with your master password, and use the 💬 Chat tab.

## Recommended extra lock (2 minutes) — Cloudflare Access

Add a second gate so only YOU can even reach the page:
- Cloudflare dashboard → **Zero Trust → Access → Applications → Add an
  application → Self-hosted** → app domain `atlas.evervibesdigital.com` →
  policy: allow only your email (one-time PIN). Free for up to 50 users.

## Security notes

- The panel binds `127.0.0.1` only; the tunnel connects to it locally.
- Master-password unlock now locks out after repeated failures.
- Secret/credential VALUES are never sent to the browser.
- Your laptop must be on (it is — 24/7 setup) for the tunnel to serve.
