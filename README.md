# 🚀 Cloudflare Tunnel Manager

[![Release](https://img.shields.io/github/v/release/mlluiz39/cloudflare-tunnel-full?color=blue&label=Release)](https://github.com/mlluiz39/cloudflare-tunnel-full/releases)\
[![License](https://img.shields.io/github/license/mlluiz39/cloudflare-tunnel-full?color=green)](https://github.com/mlluiz39/cloudflare-tunnel-full/blob/main/LICENSE)\
[![Issues](https://img.shields.io/github/issues/mlluiz39/cloudflare-tunnel-full?color=yellow)](https://github.com/mlluiz39/cloudflare-tunnel-full/issues)

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
git clone https://github.com/mlluiz39/cloudflare-tunnel-full.git
cd cloudflare-tunnel-full
chmod +x cloudflare-tunnel-manager-v2.sh
./cloudflare-tunnel-manager-v2.sh
```

------------------------------------------------------------------------

## 📘 Guia de Uso

O script abre um menu interativo com várias opções:

| Opção | Função |
|-------|--------|
| 1️⃣   | Instalar ou atualizar **Cloudflared** |
| 2️⃣   | Autenticar com Cloudflare |
| 3️⃣   | Criar túnel e configurar subdomínios |
| 4️⃣   | Editar e validar configurações |
| 5️⃣   | Criar registros DNS |
| 6️⃣   | Executar túnel manualmente |
| 7️⃣   | Ativar ou desativar inicialização automática |
| 8️⃣   | Gerenciar serviço e visualizar logs |
| 9️⃣   | Fazer backup das configurações |
| 🔟   | Excluir túnel com confirmação |
| 1️⃣1️⃣ | Desinstalar Cloudflared preservando configurações |
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
./cloudflare-tunnel-full.sh
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
