# 🚀 Cloudflare Tunnel Manager

[![GitHub release](https://img.shields.io/github/v/release/mlluiz39/cloudflare-tunnel-full?color=blue&label=Release)](https://github.com/mlluiz39/cloudflare-tunnel-full/releases)  
[![License](https://img.shields.io/github/license/mlluiz39/cloudflare-tunnel-full?color=green)](https://github.com/mlluiz39/cloudflare-tunnel-full/blob/main/LICENSE)  
[![GitHub issues](https://img.shields.io/github/issues/mlluiz39/cloudflare-tunnel-full?color=yellow)](https://github.com/mlluiz39/cloudflare-tunnel-full/issues)

Um **script Bash interativo** para gerenciar Cloudflare Tunnels diretamente do terminal. Crie, configure, rode e limpe túneis facilmente. Suporta múltiplos túneis e subdomínios automáticos.

---

## 🌟 Funcionalidades

- Instalação e autenticação do `cloudflared`
- Criação e exclusão de túneis
- Edição de regras de ingress (subdomínios e portas)
- Roteamento de subdomínios para túneis
- Execução manual de túneis
- Auto-start via systemd por túnel
- Visualização, reinício e parada de serviços individualizados
- Limpeza completa de túneis e arquivos de configuração

---

## 🛠️ Instalação

Clone o repositório:

```bash
git clone https://github.com/mlluiz39/cloudflare-tunnel-full.git
cd cloudflare-tunnel-full
chmod +x ./cloudflare-tunnel-full.sh

./cloudflare-tunnel-full.sh

📘 Guia de Uso
Menu Interativo

O script possui um menu interativo com as seguintes opções:

1️⃣ Instalar cloudflared

Baixa e instala a última versão disponível.

2️⃣ Autenticar com Cloudflare

Abre o navegador ou fornece link de login para servidores headless. Após autenticação, salva cert.pem em ~/.cloudflared/.

# Alternativa via scp
scp ~/.cloudflared/cert.pem user@seu-servidor:~/.cloudflared/

3️⃣ Criar Novo Túnel

Solicita o nome do túnel, cria e gera automaticamente o .yml.
Suporta múltiplos subdomínios com portas diferentes.

4️⃣ Editar Configuração do Túnel

Abre o arquivo YAML no nano para modificar subdomínios, portas e serviços.

5️⃣ Roteamento de Subdomínios

Adiciona registros DNS no Cloudflare apontando para o túnel selecionado.

6️⃣ Rodar Túnel Manualmente

Inicia o túnel sem systemd ou auto-start.

# Exemplo
./cloudflare-tunnel-full.sh
# Escolha a opção 6

7️⃣ Habilitar/Desabilitar Auto-Start

Configura o start automático via cloudflared@<tunnel>.service.
Detecta e remove configurações conflitantes no /etc/cloudflared/config.yml após confirmação.

8️⃣ Gerenciar Serviço do Túnel

🔄 Reiniciar

🛑 Parar

📊 Ver status

📜 Visualizar logs em tempo real

9️⃣ Deletar Túnel

Remove um túnel específico da Cloudflare e apaga arquivos locais.

🔟 Desinstalação Completa e Limpeza

Remove binário, credenciais, configs e arquivos .deb.

0️⃣ Sair

Fecha o menu e encerra o script.

📁 Estrutura de Diretórios
~/.cloudflared/
├── <nome-do-tunel>.yml
├── <id-do-tunel>.json
├── cert.pem

⚠️ Observações

Evite editar /etc/cloudflared/config.yml diretamente.

Ao habilitar auto-start, o script remove conflitos do sistema após confirmação.

Múltiplos túneis e subdomínios automáticos implementados no config.sh.

💡 Exemplos de Comandos

Rodar túnel manualmente:

./cloudflare-tunnel-full.sh
# Escolha a opção 6


Adicionar subdomínio ao túnel:

# Escolha a opção 5 no menu


Habilitar auto-start:

# Escolha a opção 7 no menu

👨‍💻 Autor

Marcelo Luiz 

Sinta-se à vontade para abrir issues ou sugerir melhorias no GitHub.

🌟 Contribuições

Contribuições são bem-vindas!

Fork este repositório

Crie uma branch (git checkout -b feature/nova-funcionalidade)

Commit suas alterações (git commit -m 'Adiciona nova funcionalidade')

Push para a branch (git push origin feature/nova-funcionalidade)

Abra um Pull Request

📄 Licença

Este projeto está licenciado sob a MIT License — veja o arquivo LICENSE
 para detalhes.

```
