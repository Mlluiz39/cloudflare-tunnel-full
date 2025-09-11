# 🚀 Cloudflare Tunnel Manager

[![Release](https://img.shields.io/github/v/release/mlluiz39/cloudflare-tunnel-manager?color=blue&label=Release)](https://github.com/mlluiz39/cloudflare-tunnel-manager/releases)\
[![License](https://img.shields.io/github/license/mlluiz39/cloudflare-tunnel-manager?color=green)](https://github.com/mlluiz39/cloudflare-tunnel-manager/blob/main/LICENSE)\
[![Issues](https://img.shields.io/github/issues/mlluiz39/cloudflare-tunnel-manager?color=yellow)](https://github.com/mlluiz39/cloudflare-tunnel-manager/issues)

Um **script Bash interativo** para gerenciar **Cloudflare Tunnels**
diretamente do terminal.\
Crie, configure, rode e limpe túneis com facilidade.\
👉 Suporta múltiplos túneis e subdomínios automáticos.

------------------------------------------------------------------------

## ✨ Funcionalidades

- ✅ Instalação e autenticação do **cloudflared**\
- ✅ Criação e exclusão de túneis\
- ✅ Edição de regras de ingress (subdomínios e portas)\
- ✅ Roteamento de subdomínios para túneis\
- ✅ Execução manual de túneis\
- ✅ Auto-start via **systemd** por túnel\
- ✅ Visualização, reinício e parada de serviços\
- ✅ Limpeza completa de túneis e arquivos de configuração

------------------------------------------------------------------------

## ⚙️ Instalação

Clone o repositório e dê permissão de execução:

``` bash
git clone https://github.com/mlluiz39/cloudflare-tunnel-manager.git
cd cloudflare-tunnel-manager
chmod +x ./cloudflare-tunnel-manager.sh
./cloudflare-tunnel-manager.sh
```

------------------------------------------------------------------------

## 📘 Guia de Uso

O script abre um menu interativo com várias opções:

| Opção | Função |
|-------|--------|
| 1️⃣   | Instalar **cloudflared** |
| 2️⃣   | Autenticar com Cloudflare |
| 3️⃣   | Criar novo túnel |
| 4️⃣   | Editar configuração do túnel |
| 5️⃣   | Roteamento de subdomínios |
| 6️⃣   | Rodar túnel manualmente |
| 7️⃣   | Habilitar/desabilitar auto-start |
| 8️⃣   | Gerenciar serviço do túnel |
| 9️⃣   | Deletar serviço **systemd** |
| 🔟   | Desinstalação completa |
| 1️⃣1️⃣ | Deletar túnel específico |
| 0️⃣   | Sair |

## 📂 Estrutura de Diretórios

As configurações e credenciais ficam em:

``` bash
~/.cloudflared/
├── <nome-do-tunel>.yml
├── <id-do-tunel>.json
└── cert.pem
```

⚠️ **Atenção:**\
- Evite editar `/etc/cloudflared/config.yml` diretamente.\
- O script já remove conflitos de configuração ao habilitar auto-start.

------------------------------------------------------------------------

## 💡 Exemplos Rápidos

Rodar túnel manualmente:

``` bash
./cloudflare-tunnel-manager.sh
# Escolher opção 6
```

Adicionar subdomínio:

``` bash
# Escolher opção 5
```

Ativar auto-start:

``` bash
# Escolher opção 7
```

------------------------------------------------------------------------

## 👨‍💻 Autor

**Marcelo Luiz**\
🌐 [GitHub](https://github.com/mlluiz39)

Sinta-se à vontade para abrir **issues** ou sugerir melhorias 🚀
