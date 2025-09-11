#!/bin/bash

USERNAME=$(whoami)
CLOUDFLARED_DIR="$HOME/.cloudflared"

show_menu() {
  echo -e "\n🚀 Cloudflare Tunnel Manager"
  echo "1. Install cloudflared"
  echo "2. Authenticate with Cloudflare"
  echo "3. Create new tunnel (auto config with subdomains)"
  echo "4. Edit tunnel config (ingress rules)"
  echo "5. Route subdomains to tunnel"
  echo "6. Run tunnel manually"
  echo "7. Enable/Disable auto-start for tunnel"
  echo "8. Restart/Stop/View systemd service"
  echo "9. Delete a tunnel"
  echo "10. Full uninstall and cleanup"
  echo "0. Exit"
  echo -n "Select an option [0-10]: "
}

select_tunnel() {
  mapfile -t TUNNEL_LIST < <(cloudflared tunnel list | awk 'NR>1 {print $2}')
  if [ ${#TUNNEL_LIST[@]} -eq 0 ]; then
    echo "❌ No tunnels found. Create one first."
    return 1
  fi

  echo -e "\n📜 Available Tunnels:"
  for i in "${!TUNNEL_LIST[@]}"; do
    echo "$((i+1)). ${TUNNEL_LIST[$i]}"
  done

  read -p "Select a tunnel by number: " num
  if [[ "$num" =~ ^[0-9]+$ ]] && [ "$num" -ge 1 ] && [ "$num" -le ${#TUNNEL_LIST[@]} ]; then
    TUNNEL_NAME="${TUNNEL_LIST[$((num-1))]}"
  else
    echo "❌ Invalid selection."
    return 1
  fi
}

install_cloudflared() {
  wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  sudo dpkg -i cloudflared-linux-amd64.deb
  cloudflared --version
}

login_cloudflare() {
  cloudflared tunnel login
}

create_tunnel() {
  read -p "Enter a name for the tunnel: " TUNNEL_NAME
  echo "⛏️  Creating tunnel '$TUNNEL_NAME'..."
  cloudflared tunnel create "$TUNNEL_NAME"

  TUNNEL_ID=$(cloudflared tunnel list | awk -v name="$TUNNEL_NAME" '$2 == name {print $1; exit}')
  CREDENTIALS_FILE="$CLOUDFLARED_DIR/$TUNNEL_ID.json"
  TUNNEL_CONFIG="$CLOUDFLARED_DIR/$TUNNEL_NAME.yml"

  if [[ -z "$TUNNEL_ID" ]]; then
    echo "❌ Failed to get Tunnel ID for '$TUNNEL_NAME'."
    return 1
  fi

  echo "📝 Enter subdomains to route to this tunnel (type 'done' when finished):"
  INGRESS_RULES=""
  SUBDOMAINS=()
  while true; do
    read -p "Subdomain: " DOMAIN
    [ "$DOMAIN" == "done" ] && break
    read -p "Local service port for $DOMAIN (default 80): " PORT
    PORT=${PORT:-80}
    INGRESS_RULES+="  - hostname: $DOMAIN\n    service: http://localhost:$PORT\n"
    SUBDOMAINS+=("$DOMAIN")
  done
  INGRESS_RULES+="  - service: http_status:404\n"

  echo -e "tunnel: $TUNNEL_ID
credentials-file: $CREDENTIALS_FILE

ingress:
$INGRESS_RULES" > "$TUNNEL_CONFIG"

  echo "✅ Tunnel '$TUNNEL_NAME' and subdomains configured successfully."
  echo "📄 Config file: $TUNNEL_CONFIG"

  # 🚀 Roteamento automático de DNS para todos os subdomínios
  if [ ${#SUBDOMAINS[@]} -gt 0 ]; then
    echo "🌐 Routing subdomains to tunnel..."
    for SD in "${SUBDOMAINS[@]}"; do
      OUTPUT=$(cloudflared tunnel route dns "$TUNNEL_NAME" "$SD" 2>&1)
      if echo "$OUTPUT" | grep -q "already configured"; then
        echo "⚠️  $SD already routed."
      else
        echo "✅ Routed $SD"
      fi
    done
  fi
}

edit_tunnel_config() {
  select_tunnel || return 1
  TUNNEL_ID=$(cloudflared tunnel list | awk -v name="$TUNNEL_NAME" '$2 == name {print $1; exit}')
  TUNNEL_CONFIG="$CLOUDFLARED_DIR/$TUNNEL_NAME.yml"
  CREDENTIALS_FILE="$CLOUDFLARED_DIR/$TUNNEL_ID.json"

  if [ ! -f "$TUNNEL_CONFIG" ]; then
    echo "⚠️ Config not found. Creating default at $TUNNEL_CONFIG"
    cat > "$TUNNEL_CONFIG" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CREDENTIALS_FILE

ingress:
  - hostname: dev.example.com
    service: http://localhost:80
  - hostname: admin.example.com
    service: http://localhost:8080
  - service: http_status:404
EOF
    echo "✅ Default config created."
  fi

  nano "$TUNNEL_CONFIG"
}

route_dns() {
  select_tunnel || return 1
  while true; do
    read -p "Enter subdomain to route (or 'done'): " DOMAIN
    [ "$DOMAIN" == "done" ] && break
    OUTPUT=$(cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN" 2>&1)
    if echo "$OUTPUT" | grep -q "already configured"; then
      echo "⚠️  $DOMAIN already routed."
      continue
    fi
    echo "$OUTPUT"
  done
}

run_tunnel() {
  select_tunnel || return 1
  TUNNEL_CONFIG="$CLOUDFLARED_DIR/$TUNNEL_NAME.yml"

  if [ ! -f "$TUNNEL_CONFIG" ]; then
    echo "❌ Config not found: $TUNNEL_CONFIG"
    return 1
  fi

  CREDENTIALS_FILE=$(grep 'credentials-file:' "$TUNNEL_CONFIG" | awk '{print $2}')
  if [ ! -f "$CREDENTIALS_FILE" ]; then
    echo "❌ Credentials file not found: $CREDENTIALS_FILE"
    return 1
  fi

  echo "🚀 Running tunnel $TUNNEL_NAME with config $TUNNEL_CONFIG"
  cloudflared tunnel --config "$TUNNEL_CONFIG" run "$TUNNEL_NAME"
}

toggle_autostart() {
  select_tunnel || return 1
  TUNNEL_CONFIG="$CLOUDFLARED_DIR/$TUNNEL_NAME.yml"
  [ -f "$TUNNEL_CONFIG" ] || { echo "❌ Config not found: $TUNNEL_CONFIG"; return 1; }

  echo "1. Enable auto-start"
  echo "2. Disable auto-start"
  read -p "Choose [1-2]: " action

  case "$action" in
    1)
      if [ ! -f /etc/systemd/system/cloudflared@.service ]; then
        echo "❌ Generic systemd service not found. Creating..."
        sudo tee /etc/systemd/system/cloudflared@.service > /dev/null <<EOF
[Unit]
Description=Cloudflare Tunnel %i
After=network.target

[Service]
Type=simple
User=$USERNAME
ExecStart=/usr/local/bin/cloudflared tunnel --config $CLOUDFLARED_DIR/%i.yml run %i
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF
        sudo systemctl daemon-reload
        echo "✅ Generic systemd service created."
      fi

      sudo systemctl enable cloudflared@"$TUNNEL_NAME".service
      sudo systemctl start cloudflared@"$TUNNEL_NAME".service
      echo "✅ Auto-start enabled for tunnel '$TUNNEL_NAME'."
      ;;
    2)
      sudo systemctl stop cloudflared@"$TUNNEL_NAME".service
      sudo systemctl disable cloudflared@"$TUNNEL_NAME".service
      echo "✅ Auto-start disabled for tunnel '$TUNNEL_NAME'."
      ;;
    *)
      echo "❌ Invalid choice."
      ;;
  esac
}

manage_service() {
  select_tunnel || return 1
  echo "a. Restart"
  echo "b. Stop"
  echo "c. Status"
  echo "d. View Logs"
  read -p "Choose action [a-d]: " action
  case $action in
    a) sudo systemctl restart cloudflared@"$TUNNEL_NAME".service ;;
    b) sudo systemctl stop cloudflared@"$TUNNEL_NAME".service ;;
    c) sudo systemctl status cloudflared@"$TUNNEL_NAME".service ;;
    d) sudo journalctl -u cloudflared@"$TUNNEL_NAME" -f ;;
    *) echo "❌ Invalid option" ;;
  esac
}

delete_tunnel() {
  select_tunnel || return 1
  TUNNEL_ID=$(cloudflared tunnel list | awk -v name="$TUNNEL_NAME" '$2 == name {print $1; exit}')
  [ -n "$TUNNEL_ID" ] || { echo "❌ Tunnel not found"; return 1; }

  sudo systemctl stop cloudflared@"$TUNNEL_NAME".service 2>/dev/null
  sudo systemctl disable cloudflared@"$TUNNEL_NAME".service 2>/dev/null

  cloudflared tunnel cleanup "$TUNNEL_NAME"
  cloudflared tunnel delete "$TUNNEL_NAME"

  rm -f "$CLOUDFLARED_DIR/$TUNNEL_ID.json" "$CLOUDFLARED_DIR/$TUNNEL_NAME.yml"
  echo "✅ Tunnel deleted."
}

full_cleanup() {
  echo "⚠️ Full cleanup will remove all tunnels and cloudflared."
  read -p "Proceed? [y/N]: " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || return 1
  for tunnel in $(cloudflared tunnel list | awk 'NR>1 {print $2}'); do
    TUNNEL_NAME="$tunnel"
    delete_tunnel
  done
  sudo apt remove cloudflared -y
  sudo rm -rf "$CLOUDFLARED_DIR"
  echo "✅ All tunnels and cloudflared removed."
}

while true; do
  show_menu
  read choice
  case $choice in
    1) install_cloudflared ;;
    2) login_cloudflare ;;
    3) create_tunnel ;;
    4) edit_tunnel_config ;;
    5) route_dns ;;
    6) run_tunnel ;;
    7) toggle_autostart ;;
    8) manage_service ;;
    9) delete_tunnel ;;
    10) full_cleanup ;;
    0) exit ;;
    *) echo "❌ Invalid choice." ;;
  esac
done
