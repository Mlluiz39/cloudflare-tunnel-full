#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Cloudflare Tunnel Manager v2 - locally managed tunnels
# Run as a regular user with sudo privileges, not as root.

if [[ ${EUID} -eq 0 ]]; then
  echo 'Execute como usuario normal (ex.: ubuntu), sem sudo; o script pedira sudo quando necessario.' >&2
  exit 1
fi

BASE_DIR="${HOME}/.cloudflared"
SYSTEMD_DIR='/etc/systemd/system'
SERVICE_PREFIX='cloudflared-manager@'
mkdir -p "$BASE_DIR"
chmod 700 "$BASE_DIR"

info() { printf '\n[INFO] %s\n' "$*"; }
warn() { printf '\n[AVISO] %s\n' "$*" >&2; }
fail() { printf '\n[ERRO] %s\n' "$*" >&2; return 1; }
pause() { read -r -p $'\nPressione Enter para continuar...' _ || true; }
require_cloudflared() { command -v cloudflared >/dev/null || fail 'Cloudflared nao instalado. Escolha a opcao 1.'; }
valid_name() { [[ $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$ ]]; }
valid_hostname() { [[ $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] && [[ $1 != *..* ]]; }
valid_port() { [[ $1 =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }
confirm() { local answer; read -r -p "$1 [digite SIM]: " answer; [[ $answer == 'SIM' ]]; }

install_cloudflared() {
  local arch package tmp url
  arch=$(dpkg --print-architecture)
  case "$arch" in
    amd64|arm64) package="cloudflared-linux-${arch}.deb" ;;
    *) fail "Arquitetura nao suportada: $arch"; return 1 ;;
  esac
  tmp=$(mktemp --suffix=.deb)
  url="https://github.com/cloudflare/cloudflared/releases/latest/download/${package}"
  info "Baixando pacote oficial: $package"
  if ! curl -fL --retry 3 --connect-timeout 15 -o "$tmp" "$url"; then
    rm -f "$tmp"
    fail 'Falha no download.'
    return 1
  fi
  if ! sudo apt install -y "$tmp"; then
    rm -f "$tmp"
    fail 'Falha na instalacao do pacote.'
    return 1
  fi
  rm -f "$tmp"
  cloudflared --version
}

login_cloudflare() {
  require_cloudflared || return 1
  info 'Autenticacao Cloudflare (cert.pem ficara no seu diretorio ~/.cloudflared).'
  cloudflared tunnel login
  [[ ! -f "$BASE_DIR/cert.pem" ]] || chmod 600 "$BASE_DIR/cert.pem"
}

# UUIDs are read from cloudflared list output, not derived from names.
tunnel_uuid() {
  local name=$1
  cloudflared tunnel list --output json | python3 -c '
import json,sys
name=sys.argv[1]
for tunnel in json.load(sys.stdin):
    if tunnel.get("name") == name:
        print(tunnel["id"])
        break
' "$name"
}

select_tunnel() {
  require_cloudflared || return 1
  local -a names=()
  local name number
  mapfile -t names < <(cloudflared tunnel list --output json | python3 -c 'import json,sys; [print(t["name"]) for t in json.load(sys.stdin)]')
  if ((${#names[@]} == 0)); then fail 'Nenhum tunnel encontrado nesta conta.'; return 1; fi
  printf '\nTuneis disponiveis:\n'
  for number in "${!names[@]}"; do printf ' %d) %s\n' "$((number+1))" "${names[$number]}"; done
  read -r -p 'Numero: ' number
  if [[ ! $number =~ ^[0-9]+$ ]] || ((number < 1 || number > ${#names[@]})); then
    fail 'Selecao invalida'; return 1
  fi
  TUNNEL_NAME=${names[$((number-1))]}
  valid_name "$TUNNEL_NAME" || { fail 'Nome de tunnel nao compativel com o gerenciador'; return 1; }
  TUNNEL_ID=$(tunnel_uuid "$TUNNEL_NAME")
  [[ -n $TUNNEL_ID ]] || { fail 'UUID nao encontrado'; return 1; }
  CONFIG="$BASE_DIR/${TUNNEL_NAME}.yml"
  CREDS="$BASE_DIR/${TUNNEL_ID}.json"
}

write_config() {
  local config=$1 uuid=$2 creds=$3
  shift 3
  {
    printf 'tunnel: %s\n' "$uuid"
    printf 'credentials-file: %s\n' "$creds"
    printf '\ningress:\n'
    if (($#)); then printf '%s\n' "$@"; fi
    printf '  - service: http_status:404\n'
  } > "$config"
  chmod 600 "$config"
}

validate_config() {
  local config=$1
  cloudflared --config "$config" tunnel ingress validate
}

add_routes_interactively() {
  local -n out_routes=$1
  local -n out_domains=$2
  local host port scheme
  while true; do
    read -r -p 'Hostname completo (ex.: api.exemplo.com), Enter para terminar: ' host
    [[ -n $host ]] || break
    if ! valid_hostname "$host"; then warn 'Hostname invalido'; continue; fi
    read -r -p "Porta local de $host (ex.: 3000): " port
    if ! valid_port "$port"; then warn 'Porta invalida'; continue; fi
    read -r -p 'Protocolo local [http/https] (padrao http): ' scheme
    scheme=${scheme:-http}
    if [[ $scheme != http && $scheme != https ]]; then warn 'Protocolo invalido'; continue; fi
    out_routes+=("  - hostname: $host" "    service: ${scheme}://127.0.0.1:${port}")
    out_domains+=("$host")
  done
}

route_dns_one() {
  local name=$1 domain=$2
  info "Criando DNS para $domain"
  if ! cloudflared tunnel route dns "$name" "$domain"; then
    warn "Nao foi possivel configurar DNS de $domain. Verifique se ja existe um registro."
  fi
}

create_tunnel() {
  require_cloudflared || return 1
  local name uuid creds config
  local -a routes=() domains=()
  read -r -p 'Nome do novo tunnel (letras, numeros, _ e -): ' name
  valid_name "$name" || { fail 'Nome invalido'; return 1; }
  if [[ -e "$BASE_DIR/$name.yml" ]]; then fail 'Ja existe arquivo de configuracao com esse nome'; return 1; fi
  cloudflared tunnel create "$name" || return 1
  uuid=$(tunnel_uuid "$name")
  [[ -n $uuid ]] || { fail 'Tunnel criado, mas UUID nao localizado; verifique tunnel list'; return 1; }
  creds="$BASE_DIR/$uuid.json"
  config="$BASE_DIR/$name.yml"
  [[ -f $creds ]] || { fail "Credenciais nao encontradas: $creds"; return 1; }
  chmod 600 "$creds"
  add_routes_interactively routes domains
  write_config "$config" "$uuid" "$creds" "${routes[@]}"
  if ! validate_config "$config"; then warn "Configuracao invalida: $config"; return 1; fi
  info "Tunnel $name criado. Configuracao: $config"
  if ((${#domains[@]})); then
    if confirm 'Criar os registros DNS agora?'; then
      local domain
      for domain in "${domains[@]}"; do route_dns_one "$name" "$domain"; done
    fi
  fi
  info 'Use a opcao 7 para ativar o servico systemd.'
}

edit_config() {
  select_tunnel || return 1
  [[ -f $CONFIG ]] || { fail "Configuracao local nao encontrada: $CONFIG"; return 1; }
  local backup
  backup=$(mktemp "$BASE_DIR/.${TUNNEL_NAME}.XXXXXX")
  cp -p "$CONFIG" "$backup"
  ${EDITOR:-nano} "$CONFIG"
  chmod 600 "$CONFIG"
  if validate_config "$CONFIG"; then
    rm -f "$backup"
    info 'Configuracao validada. Reinicie o servico para aplicar.'
  else
    warn 'Configuracao invalida; restaurando a versao anterior.'
    cp -p "$backup" "$CONFIG"
    rm -f "$backup"
  fi
}

route_dns() {
  select_tunnel || return 1
  local domain
  while true; do
    read -r -p 'Hostname para criar DNS (Enter para sair): ' domain
    [[ -n $domain ]] || break
    if valid_hostname "$domain"; then route_dns_one "$TUNNEL_NAME" "$domain"; else warn 'Hostname invalido'; fi
  done
  info 'DNS e ingress sao configuracoes separadas: confira o arquivo .yml.'
}

run_tunnel() {
  select_tunnel || return 1
  [[ -f $CONFIG && -f $CREDS ]] || { fail 'Configuracao ou credenciais ausentes'; return 1; }
  validate_config "$CONFIG" || return 1
  cloudflared --config "$CONFIG" tunnel run "$TUNNEL_ID"
}

service_file() { printf '%s/%s.service' "$SYSTEMD_DIR" "${SERVICE_PREFIX%.@}@"; }

install_service_template() {
  local bin unit
  bin=$(command -v cloudflared)
  [[ -n $bin ]] || { fail 'Cloudflared nao instalado'; return 1; }
  unit="$SYSTEMD_DIR/cloudflared-manager@.service"
  # Paths with whitespace are not supported by this systemd template.
  if [[ $HOME == *' '* ]]; then fail 'HOME com espacos nao suportado pelo template'; return 1; fi
  sudo tee "$unit" >/dev/null <<EOF
[Unit]
Description=Cloudflare Tunnel Manager - %i
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$(id -un)
Environment=HOME=$HOME
ExecStart=$bin --config $BASE_DIR/%i.yml tunnel run
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=false
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
}

autostart() {
  select_tunnel || return 1
  [[ -f $CONFIG && -f $CREDS ]] || { fail 'Configuracao ou credenciais ausentes'; return 1; }
  printf '1) Ativar  2) Desativar\n'
  local choice
  read -r -p 'Opcao: ' choice
  case $choice in
    1)
      validate_config "$CONFIG" || return 1
      install_service_template || return 1
      sudo systemctl enable --now "${SERVICE_PREFIX}${TUNNEL_NAME}.service"
      sudo systemctl --no-pager --full status "${SERVICE_PREFIX}${TUNNEL_NAME}.service" || true
      ;;
    2)
      sudo systemctl disable --now "${SERVICE_PREFIX}${TUNNEL_NAME}.service" || true
      ;;
    *) warn 'Opcao invalida' ;;
  esac
}

manage_service() {
  select_tunnel || return 1
  printf '1) Reiniciar  2) Parar  3) Status  4) Logs (ultimas 80 linhas)\n'
  local choice service="${SERVICE_PREFIX}${TUNNEL_NAME}.service"
  read -r -p 'Opcao: ' choice
  case $choice in
    1) validate_config "$CONFIG" && sudo systemctl restart "$service" ;;
    2) sudo systemctl stop "$service" ;;
    3) sudo systemctl --no-pager --full status "$service" || true ;;
    4) sudo journalctl -u "$service" -n 80 --no-pager ;;
    *) warn 'Opcao invalida' ;;
  esac
}

backup_configs() {
  local backupdir="$HOME/cloudflared-backups" destination
  mkdir -p "$backupdir"
  chmod 700 "$backupdir"
  destination="$backupdir/cloudflared-$(date +%Y%m%d-%H%M%S).tar.gz"
  tar -C "$HOME" -czf "$destination" .cloudflared
  chmod 600 "$destination"
  info "Backup criado: $destination"
  warn 'O backup contem credenciais secretas. Guarde-o de forma criptografada e segura.'
}

delete_tunnel() {
  select_tunnel || return 1
  printf 'Tunnel selecionado: %s (%s)\n' "$TUNNEL_NAME" "$TUNNEL_ID"
  warn 'A exclusao remota nao remove automaticamente registros DNS associados.'
  confirm "Excluir definitivamente o tunnel $TUNNEL_NAME?" || return 0
  sudo systemctl disable --now "${SERVICE_PREFIX}${TUNNEL_NAME}.service" 2>/dev/null || true
  cloudflared tunnel cleanup "$TUNNEL_ID" || warn 'Cleanup remoto nao concluido'
  if cloudflared tunnel delete "$TUNNEL_ID"; then
    rm -f -- "$CONFIG" "$CREDS"
    info 'Tunnel excluido. Confira registros DNS antigos no painel Cloudflare.'
  else
    warn 'Exclusao remota falhou; arquivos locais preservados.'
  fi
}

uninstall_local() {
  warn 'Esta opcao remove o pacote cloudflared e o template systemd local.'
  warn 'Nao apaga tuneis remotos, configuracoes ou credenciais.'
  confirm 'Desinstalar cloudflared localmente?' || return 0
  local unit
  while IFS= read -r unit; do
    [[ -n $unit ]] && sudo systemctl disable --now "$unit" || true
  done < <(systemctl list-unit-files --no-legend 'cloudflared-manager@*.service' | awk '{print $1}')
  sudo rm -f "$SYSTEMD_DIR/cloudflared-manager@.service"
  sudo systemctl daemon-reload
  sudo apt remove -y cloudflared
  info 'Pacote removido; ~/.cloudflared preservado.'
}

menu() {
  cat <<'EOF'

===== Cloudflare Tunnel Manager v2 =====
 1) Instalar/atualizar cloudflared (ARM64/AMD64)
 2) Autenticar na Cloudflare
 3) Criar tunnel e configurar ingress
 4) Editar ingress (com validacao)
 5) Criar registros DNS
 6) Executar tunnel manualmente
 7) Ativar/desativar inicio automatico
 8) Reiniciar/parar/status/logs do servico
 9) Backup das configuracoes
10) Excluir um tunnel (confirmacao)
11) Desinstalar pacote local (preserva tuneis)
 0) Sair
EOF
}

main() {
  local choice
  while true; do
    menu
    read -r -p 'Escolha: ' choice || break
    case $choice in
      1) install_cloudflared || true ;;
      2) login_cloudflare || true ;;
      3) create_tunnel || true ;;
      4) edit_config || true ;;
      5) route_dns || true ;;
      6) run_tunnel || true ;;
      7) autostart || true ;;
      8) manage_service || true ;;
      9) backup_configs || true ;;
      10) delete_tunnel || true ;;
      11) uninstall_local || true ;;
      0) break ;;
      *) warn 'Opcao invalida' ;;
    esac
    pause
  done
}
main "$@"
