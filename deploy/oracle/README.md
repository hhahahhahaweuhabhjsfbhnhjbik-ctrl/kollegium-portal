# Oracle Cloud deployment

This deployment runs the Node.js portal and Discord bot together on one Oracle Cloud VM. SQLite and Caddy's TLS data are stored in Docker volumes. GitHub Actions deploys new commits from `main` over SSH.

## 1. Create the VM

Create an Always Free Ubuntu VM in Oracle Cloud. Save its public IPv4 address and allow inbound TCP ports `22`, `80`, and `443` in the VM's network security rules. Do not expose port `3000`.

Connect as the VM's default Ubuntu user, then install Docker and Git:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 git
sudo systemctl enable --now docker
```

Clone the public repository and prepare its private environment file:

```bash
sudo mkdir -p /opt/kollegium-portal
sudo chown "$USER":"$USER" /opt/kollegium-portal
git clone https://github.com/hhahahhahaweuhabhjsfbhnhjbik-ctrl/kollegium-portal.git /opt/kollegium-portal
cd /opt/kollegium-portal
cp .env.example .env
chmod 600 .env
nano .env
```

Set `DOMAIN` to the DuckDNS hostname you registered, and set the Discord OAuth and bot values. `DISCORD_REDIRECT_URI` must be `https://<your-DuckDNS-hostname>/api/discord/callback`. Save `.env` only on the VM; never commit it. DuckDNS gives you a free subdomain, not a Cloudflare-registered domain. To use Cloudflare Registrar instead, you must register a domain there and point its DNS to this VM.

## 2. Configure DuckDNS and Discord

Register a free subdomain at [DuckDNS](https://www.duckdns.org/), then set its IPv4 address to the VM's public IPv4. If the VM's public IP changes, update the DuckDNS record.

In the Discord Developer Portal, add the same HTTPS callback URL from `.env` under OAuth2 Redirects. Use newly issued Discord credentials if older tokens or secrets were exposed.

To enable the text-based `!tech` maintenance and restart commands, enable **Message Content Intent** under the bot's Developer Portal → Bot settings. Only the Discord server owner and administrators can use these commands.

## 3. Start and verify the service

Wait until the DuckDNS hostname resolves to the VM, then run:

```bash
cd /opt/kollegium-portal
sudo docker compose -f deploy/oracle/compose.yaml up -d --build
sudo docker compose -f deploy/oracle/compose.yaml ps
curl -fsS https://<your-DuckDNS-hostname>/api/health
```

The health endpoint should return JSON containing `"ok":true`. The app database is kept in the `portal_data` Docker volume across rebuilds and restarts. Back it up regularly.

## 4. Enable deployment from GitHub

Create a dedicated SSH key pair on your computer for GitHub Actions:

```powershell
ssh-keygen -t ed25519 -C github-actions-deploy -f .\oracle_deploy_key
```

Leave the passphrase empty when prompted. Add the contents of `oracle_deploy_key.pub` to the VM user's `~/.ssh/authorized_keys`, then add the contents of the private `oracle_deploy_key` file as a GitHub Actions secret. Do not commit either key file.

Add these repository Actions secrets in GitHub → Settings → Secrets and variables → Actions:

- `ORACLE_HOST`: VM public IPv4 address
- `ORACLE_USER`: VM SSH user (usually `ubuntu`)
- `ORACLE_SSH_KEY`: the private key for that VM user
- `ORACLE_KNOWN_HOSTS`: output of `ssh-keyscan -H <VM-public-IPv4>` collected from a trusted network

The workflow expects the repository at `/opt/kollegium-portal` and Docker Compose to be runnable with `sudo`. It deploys on each push to `main`; the first deployment can also be started from the Actions tab.

Oracle Always Free capacity and availability are not guaranteed. This setup uses a public VM, so keep the OS updated and restrict SSH access where practical.
