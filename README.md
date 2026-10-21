# ⚡ Cloudflare Tunnel Manager

[![Release](https://img.shields.io/github/v/release/mlluiz39/cloudflare-tunnel-full?color=blue&label=Release)](https://github.com/mlluiz39/cloudflare-tunnel-full/releases)
[![License](https://img.shields.io/github/license/mlluiz39/cloudflare-tunnel-full?color=green)](https://github.com/mlluiz39/cloudflare-tunnel-full/blob/main/LICENSE)
[![Issues](https://img.shields.io/github/issues/mlluiz39/cloudflare-tunnel-full?color=yellow)](https://github.com/mlluiz39/cloudflare-tunnel-full/issues)

Aplicativo Desktop (**Node.js / Electron**) para **publicar seus serviços locais na internet** com Cloudflare Tunnel — no **Linux**, **macOS** e **Windows**.

Você digita um subdomínio, escolhe a porta do seu serviço local e clica em um botão. O app cria o túnel, escreve a configuração, cria o DNS, sobe o serviço do sistema e **testa o endereço** para confirmar que está no ar.

```
 Você:  api  .  meudominio.com.br   →   localhost:8090
 App:   cria túnel → grava ingress → valida → cria DNS → sobe serviço → testa HTTPS
 Você:  ✅ https://api.meudominio.com.br respondendo (HTTP 200)
```

> Este app é a interface gráfica equivalente ao script `cloudflare-tunnel-manager-v2.sh`, com as mesmas garantias de segurança (validação antes de gravar, backups, permissões `600`).

---

## 📑 Índice

1. [O que você consegue fazer](#-o-que-você-consegue-fazer)
2. [Baixar e instalar](#-baixar-e-instalar)
3. [Primeiro uso em 5 passos](#-primeiro-uso-em-5-passos)
4. [Conceitos que evitam confusão](#-conceitos-que-evitam-confusão)
5. [Tour das telas](#-tour-das-telas)
6. [Receitas prontas](#-receitas-prontas)
7. [Equivalência com o terminal](#-equivalência-com-o-terminal)
8. [Arquivos e diretórios](#-arquivos-e-diretórios)
9. [Solução de problemas](#-solução-de-problemas)
10. [Segurança e limites](#-segurança-e-limites)
11. [Desenvolvimento e testes](#-desenvolvimento-e-testes)
12. [FAQ](#-faq)

---

## 🚀 O que você consegue fazer

- 🌐 **Publicar um subdomínio** apontando para qualquer coisa que rode na sua máquina (`localhost:3000`, `:8090`, `:5173`…).
- 🔍 **Ver se está funcionando** sem sair do app: porta local respondendo, DNS criado, HTTPS público retornando 200.
- ⚙️ **Ligar/desligar/ reiniciar** o túnel como serviço do sistema (systemd no Linux, launchd no macOS, serviço do Windows), com opção de subir no boot.
- 📝 **Editar a configuração** (YAML) com validação antes de salvar e backup automático.
- 📜 **Ler os logs** do serviço, ao vivo.
- 💾 **Fazer backup** de tudo (`~/.cloudflared`) em um `.tar.gz`.
- 🧹 **Excluir túneis** e limpar unidades de serviço com confirmação digitada.

---

## 📥 Baixar e instalar

Baixe o instalador do seu sistema em [**Releases**](https://github.com/mlluiz39/cloudflare-tunnel-full/releases).

| Sistema | Arquivo | Arquitetura | Como instalar |
| --- | --- | --- | --- |
| **Linux** | `.AppImage` (portátil) | x64 | `chmod +x Cloudflare*.AppImage` e dê dois cliques |
| **Linux** (Debian/Ubuntu/Pop!_OS) | `.deb` | amd64 | `sudo apt install ./cloudflare-tunnel-manager_*_amd64.deb` |
| **macOS** | `.dmg` | **Intel (x64)** | Abra o `.dmg` e arraste o app para *Aplicativos* |
| **macOS** | `-arm64.dmg` | **Apple Silicon (M1–M4)** | idem |
| **Windows** | `.exe` (NSIS) | x64 | Execute o instalador |

> **Qual .dmg baixar?** Se o "Sobre este Mac" mostrar *Chip Apple M1/M2/M3/M4*, use o `-arm64.dmg`; se mostrar *Intel*, use o `.dmg` sem sufixo. Os dois são gerados no mesmo build.

**Não é preciso instalar o `cloudflared` nem o Node.js.** O aplicativo baixa e instala o binário oficial do Cloudflare pela própria interface (**Configurações → ⬇ Instalar / atualizar**).

### Primeira abertura, por sistema

<details>
<summary><strong>Linux — AppImage pede FUSE</strong></summary>

Em algumas distribuições (Ubuntu 22.04+, Pop!_OS) o AppImage precisa do FUSE 2:

```bash
sudo apt install libfuse2t64     # ou libfuse2 em versões mais antigas
```

Sem isso, rode extraindo (funciona igual):

```bash
./Cloudflare*.AppImage --appimage-extract-and-run
```
</details>

<details>
<summary><strong>macOS — "app não pode ser aberto"</strong></summary>

O app não é assinado com certificado Apple. Para abrir:

1. Clique com o botão direito no app → **Abrir** → **Abrir** novamente, **ou**
2. `xattr -dr com.apple.quarantine "/Applications/Cloudflare Tunnel Manager.app"`
</details>

<details>
<summary><strong>Windows — SmartScreen</strong></summary>

Na tela azul "O Windows protegeu o computador": **Mais informações** → **Executar assim mesmo**.
</details>

### Requisitos

| Item | Linux | macOS | Windows |
| --- | --- | --- | --- |
| Sistema | systemd | launchd | Serviços do Windows |
| Autenticação administrativa | `pkexec` (polkit) **só** no modo *sistema* | não | UAC |
| Rede | acesso a `api.cloudflare.com` e ao edge da Cloudflare | idem | idem |

---

## 🧭 Primeiro uso em 5 passos

### Passo 1 — Abra o aplicativo

Se ainda faltar o `cloudflared`, o dashboard mostra um aviso vermelho:

> **cloudflared não está instalado.** → **[Instalar agora]**

Clique em **Instalar agora**. O app baixa o pacote oficial do Cloudflare e instala (no Linux pede sua senha em uma janela do sistema). Ao terminar, o rodapé da barra lateral passa a mostrar `cloudflared v2026.x.x`.

### Passo 2 — Autentique na Cloudflare

Clique em **🔑 Autenticar Cloudflare** (barra lateral).

- O navegador abre em `dash.cloudflare.com`.
- **Escolha o domínio** que você quer gerenciar e clique em **Authorize**.
- Volte ao app: o modal fecha sozinho e aparece “Autenticado com sucesso”.

> ⚠️ **O login autoriza UM domínio por vez.** É o que o Cloudflare gravou no arquivo `~/.cloudflared/cert.pem`. Para outro domínio, clique em **🔑 Reautenticar** e escolha o outro (isso substitui a autorização anterior).

### Passo 3 — Abra a aba 🚀 Novo Subdomínio

Você verá três blocos. Preencha:

| Campo | O que colocar | Exemplo |
| --- | --- | --- |
| **Subdomínio** | só o começo do endereço | `api` |
| **Domínio** | escolha na lista (são os domínios autorizados) | `meudominio.com.br` |
| **Porta local** | a porta onde seu serviço escuta | `8090` |

Abaixo do campo aparece o **endereço final** já montado:

```
endereço final   api.meudominio.com.br
✓ domínio autorizado: meudominio.com.br   ✓ endereço livre
```

Clique em **🔍 Testar conexão** para confirmar que o seu serviço está respondendo nessa porta (`respondendo · HTTP 200 em 5ms`).

### Passo 4 — Clique em 🚀 Criar subdomínio

O app executa tudo e mostra cada etapa:

| Etapa | O que ela faz | Se falhar |
| --- | --- | --- |
| Validar dados | confere subdomínio e porta | corrija o campo indicado |
| Conferir domínio autorizado | o hostname pertence ao domínio do seu login? | use **Reautenticar** e escolha o domínio certo |
| Conferir serviço local | há algo escutando na porta? | *só avisa* — suba seu serviço |
| Preparar túnel | cria o túnel e escreve o `ingress` no YAML | veja a mensagem (nome repetido, sem rede…) |
| Validar ingress | roda `cloudflared tunnel ingress validate` | o YAML tem erro de estrutura |
| Criar registro DNS | CNAME `<uuid>.cfargotunnel.com` | registro conflitante no mesmo hostname |
| Serviço do sistema | cria a unidade e inicia | credenciais ausentes, sem permissão |
| Testar o subdomínio | resolve o DNS e faz HTTPS | propagação de DNS (pode levar segundos) |

### Passo 5 — Abra o endereço

No fim surge o cartão:

```
✅ api.meudominio.com.br está publicado
   https://api.meudominio.com.br
   [🌐 Abrir no navegador]   [🔁 Testar de novo]
```

Pronto. O túnel já está rodando como serviço do sistema e aparece no **Dashboard**.

> 🔌 Quer que ele suba sozinho quando você ligar o computador? Marque **“Ativar no boot”** nas *Opções avançadas* antes de criar, ou use **Serviço & Logs → 🔌 Ativar no boot** depois.

---

## 🧠 Conceitos que evitam confusão

Estes quatro pontos explicam 90% das dúvidas de quem está começando.

### 1. Túnel local ≠ rotas no painel da Cloudflare

Este app administra **túneis locais**: as regras de roteamento ficam no arquivo `~/.cloudflared/<nome>.yml` (na sua máquina), e o `cloudflared` roda com `--config`.

Por isso, em **Networks → Tunnels → (seu túnel) → Public Hostnames** o painel aparece **vazio**: ele só lista rotas de túneis *remotamente gerenciados* (os criados pelo próprio painel com token). **Não é erro.**

> ⚠️ Não tente “consertar” isso adicionando um hostname naquela aba do painel: isso grava uma configuração remota que é **ignorada** pelo conector local — é a receita do clássico túnel “healthy” servindo erro 530.

### 2. `cert.pem` e `<uuid>.json` têm papéis diferentes

| Arquivo | O que ele permite | Onde é gerado |
| --- | --- | --- |
| `cert.pem` | **administrar** a conta: listar/criar túneis e criar DNS | `cloudflared tunnel login` |
| `<uuid>.json` | **rodar** aquele túnel nesta máquina | `cloudflared tunnel create` |

Se você criou um túnel em outro computador, ele aparece na lista mas **não conecta** aqui: falta o `.json`. O dashboard marca esses casos com o selo `sem credencial`.

### 3. Ingress (o “para onde”) ≠ DNS (o “nome”)

- **Ingress** = a regra que diz *“quando chegarem requisições para `api.seudominio.com`, mande para `http://127.0.0.1:8090`”* → fica no YAML.
- **DNS** = o registro CNAME que faz `api.seudominio.com` apontar para o túnel → fica na zona do seu domínio.

Um sem o outro não funciona: sem o CNAME o nome não resolve (`NXDOMAIN`); sem o ingress o túnel responde 404.

### 4. Modo de serviço: usuário ou sistema

|  | **systemd --user** (padrão) | **systemd de sistema** |
| --- | --- | --- |
| Onde vive a unidade | `~/.config/systemd/user/cloudflared-<túnel>.service` | `/etc/systemd/system/cloudflared-manager@<túnel>.service` |
| Precisa de senha | não | sim (`pkexec`/`sudo`, a cada ação) |
| Sobe no boot | sim, via `loginctl enable-linger` | sim, sem depender de login |
| Quem é o dono | você | root, rodando como você (`User=`) |

Você troca em **Configurações → Como rodar o serviço**. Mudar de modo **não move** unidades existentes: remova a unidade do túnel (**Serviço & Logs → 🗑 Remover unidade**) e crie de novo no outro modo.

---

## 🖥️ Tour das telas

### Barra lateral

Sempre visível, mostra o estado real:

- `cloudflared v2026.x.x` (verde) ou `cloudflared ausente` (vermelho);
- `autenticado` (verde) ou `não autenticado` (amarelo);
- `serviço: usuário` ou `serviço: sistema`;
- **🔑 Autenticar / Reautenticar** e **📁 Abrir ~/.cloudflared**.

O app **fecha para a bandeja** (tray). Para encerrar de verdade: clique com o botão direito no ícone da bandeja → **Sair**.

### 📊 Dashboard

Um cartão por túnel, com selos de estado:

| Selo | Significado |
| --- | --- |
| `● Rodando` / `○ Parado` | o serviço está ativo neste momento |
| `boot` | está configurado para subir no boot |
| `usuário` / `sistema` | em qual modo a unidade vive |
| `sem YAML` | não há configuração local → não dá para rodar |
| `YAML inválido` | a configuração tem erro de estrutura |
| `sem credencial` | falta o `<uuid>.json` nesta máquina |

Cada cartão mostra **rotas**, **conexões** abertas e a data de criação, mais uma lista amarela de avisos (ex.: “configuração aponta para outro túnel”).

Botões: **▶ Iniciar** (cria a unidade se preciso e sobe), **⏹ Parar**, **🔄 Reiniciar**, **📝 YAML** (abre no editor), **📜 Logs**, **🗑 Excluir**.

Embaixo dos cartões há a seção **⚠️ Configurações órfãs**: arquivos `.yml` que apontam para túneis que não existem mais, com opção de abrir ou remover.

### 🚀 Novo Subdomínio

| Campo / botão | Detalhe |
| --- | --- |
| **Subdomínio** | só o rótulo (`api`). Aceita `api.dev` para dois níveis. |
| **Domínio** | lista os domínios autorizados. A opção *outro domínio…* permite digitar. |
| **Porta local + http/https** | destino do tráfego. Use `https` se seu serviço local usa TLS. |
| **🔍 Testar conexão** | verifica a porta e faz um GET local |
| **Criar um túnel novo** / **Reaproveitar existente** | um túnel por subdomínio, ou vários subdomínios no mesmo conector |
| **Opções avançadas** | `path` (ex.: `/api`), nome do túnel, e as três caixas: *Criar registro DNS*, *Iniciar o serviço agora*, *Ativar no boot* |
| **🚀 Criar subdomínio** | executa a sequência completa |

### 📝 Editor de Ingress

- **Túnel**: escolhe o arquivo `~/.cloudflared/<nome>.yml`.
- **Rotas detectadas**: lista legível (hostname → serviço) com **Remover** em cada uma.
- **➕ Inserir no YAML**: adiciona uma rota nova sem perder comentários e mantendo o catch-all por último.
- **Arquivo YAML**: edição livre.
- **✔ Validar**: roda a validação do Cloudflare sem gravar nada.
- **💾 Salvar**: valida **antes** de gravar. Se for inválido, **nada é sobrescrito** e a mensagem aponta o problema.
- **↩ Restaurar**: cada salvamento guarda um backup (`.bak`, mantém os 5 últimos).
- **🩹 Gerar config**: cria um YAML do zero para um túnel que não tem arquivo local (pede confirmação se já existir).

### 🌐 Registros DNS

Cria o CNAME apontando o hostname ao túnel. Aceita **vários hostnames de uma vez** (um por linha) e mostra o resultado de cada um.

> O hostname precisa existir no YAML do túnel para servir tráfego — DNS e ingress são camadas diferentes.

### ⚙️ Serviço & Logs

- **Estado**: unidade, estado, modo, caminho do YAML, credenciais e número de rotas.
- **Controle**: **▶ Iniciar**, **⏹ Parar**, **🔄 Reiniciar**, **🔌 Ativar no boot**, **🚫 Desativar no boot**, **🗑 Remover unidade**.
  - *Iniciar* cria a unidade se ela não existir, mas **não** liga o autostart.
  - *Ativar no boot* faz `enable` + `loginctl enable-linger` (modo usuário).
  - *Remover unidade* apaga o arquivo do serviço; o túnel e o YAML continuam.
- **Executar manualmente**: sobe `cloudflared tunnel run` em primeiro plano e mostra a saída ao vivo — útil para depurar sem depender do serviço.
- **Logs do serviço**: **📜 Últimas linhas** (snapshot) e **📡 Acompanhar ao vivo** (`journalctl -f`).

### 🔧 Configurações

| Seção | O que faz |
| --- | --- |
| **cloudflared** | versão, binário, diretório; **⬇ Instalar / atualizar**, **🔑 Autenticar**, **🗑 Desinstalar pacote** |
| **Como rodar o serviço** | alterna entre *usuário* e *sistema* (mostra o que está disponível e o método de elevação) |
| **Backup** | **💾 Backup em ~/cloudflared-backups**, **📂 Escolher destino…**, **📁 Abrir pasta de backups** |
| **Limpeza** | **🧹 Remover todas as unidades do manager** (não apaga túneis nem `~/.cloudflared`) |
| **Sobre** | plataforma, modo atual, método de elevação, `$HOME` |

> Ações destrutivas pedem confirmação digitada: **EXCLUIR** (apagar túnel) ou **REMOVER** (desinstalar / limpar unidades).

---

## 🍳 Receitas prontas

### Publicar um app local (Node, Python, Go, o que for)

```bash
# 1) seu serviço rodando numa porta, ex.:
npm run dev          # http://localhost:3000
# 2) no app: Novo Subdomínio → dev . meudominio.com → porta 3000 → Criar
# 3) https://dev.meudominio.com  ✅
```

### Vários subdomínios no mesmo túnel (recomendado para produção)

Escolha **Reaproveitar um túnel existente** e selecione o túnel. O app adiciona a rota ao YAML daquele túnel (validando e fazendo backup antes), sem mexer nas rotas antigas. É mais leve: um único conector atende vários hostnames.

### Trocar a porta de um subdomínio já publicado

1. **Serviço & Logs → ⏹ Parar**.
2. **📝 Editor de Ingress** → ajuste a linha `service: http://127.0.0.1:8090` → **💾 Salvar**.
3. **Serviço & Logs → 🔄 Reiniciar**.

### Publicar um domínio diferente do atual

1. **🔑 Reautenticar** → no navegador escolha o **outro** domínio.
2. **Novo Subdomínio** → a lista de domínios agora mostra o novo.

### Rodar sem instalar serviço (teste rápido)

**Serviço & Logs → ▶ Executar** (execução manual). O túnel roda enquanto a janela estiver aberta; **⏹ Encerrar** para parar. Nada é gravado no systemd.

### Serviço local com HTTPS e certificado autoassinado

Em **Novo Subdomínio**, escolha `https` no seletor de esquema. Se o seu serviço local usa um certificado autoassinado, o `cloudflared` vai recusar a conexão com a origem (`x509: certificate signed by unknown authority`) — nesse caso libere a verificação naquela rota, no **Editor de Ingress**:

```yaml
ingress:
  - hostname: api.meudominio.com
    service: https://127.0.0.1:8443
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

Se o certificado for de uma CA própria (não autoassinado), prefira apontar a CA em vez de desligar a verificação:

```yaml
    originRequest:
      caPool: /caminho/ca.pem
```

### Subir tudo de novo depois de formatar a máquina

1. Instale o app e o `cloudflared` (**Configurações → ⬇ Instalar / atualizar**).
2. **🔑 Autenticar** no domínio.
3. **🩹 Gerar config** no editor para cada túnel que já existe na conta.
4. Copie os arquivos `<uuid>.json` do backup para `~/.cloudflared` (são eles que permitem conectar).
5. **Serviço & Logs → 🔌 Ativar no boot**.

---

## 🔁 Equivalência com o terminal

Cada ação da interface corresponde a comandos conhecidos:

| Na interface | Por baixo |
| --- | --- |
| 🔑 Autenticar | `cloudflared tunnel login` |
| 🚀 Criar subdomínio | `cloudflared tunnel create NOME` + editar `~/.cloudflared/NOME.yml` + `cloudflared tunnel route dns NOME host` |
| ✔ Validar (editor) | `cloudflared --config NOME.yml tunnel ingress validate` |
| ▶ Iniciar (modo usuário) | escreve `~/.config/systemd/user/cloudflared-NOME.service` + `systemctl --user start` |
| 🔌 Ativar no boot (usuário) | `systemctl --user enable --now …` + `loginctl enable-linger $USER` |
| ▶ Iniciar (modo sistema) | grava `/etc/systemd/system/cloudflared-manager@.service` + `pkexec systemctl start cloudflared-manager@NOME.service` |
| 🔌 Ativar no boot (sistema) | `pkexec systemctl enable --now cloudflared-manager@NOME.service` |
| 📜 Logs | `journalctl --user -u cloudflared-NOME -f` (ou `journalctl -u cloudflared-manager@NOME -f`) |
| ▶ Executar (manual) | `cloudflared --config NOME.yml tunnel run` |
| 💾 Backup | `tar -C ~ -czf backup.tar.gz .cloudflared` |
| 🗑 Excluir | `cloudflared tunnel cleanup ID` + `cloudflared tunnel delete ID` |
| ⬇ Instalar / atualizar | baixa o `.deb` oficial e instala via `apt` |

---

## 🗂️ Arquivos e diretórios

```
~/.cloudflared/                      # (Windows: C:\Users\<você>\.cloudflared)
├── <nome-do-tunel>.yml              # ingress (rotas) — 600
├── <uuid>.json                      # credenciais do túnel — 600
├── cert.pem                         # autorização de UM domínio — 600
└── <nome>.yml.<data>.bak            # backups do editor (5 últimos)

# Linux, modo usuário
~/.config/systemd/user/cloudflared-<túnel>.service
# Linux, modo sistema
/etc/systemd/system/cloudflared-manager@.service   (template)
/etc/systemd/system/cloudflared-manager@<túnel>.service  (instância)
# macOS
~/Library/LaunchAgents/com.cloudflared.manager.<túnel>.plist
# Windows
Serviço "CloudflareTunnel_<túnel>" (sc.exe)

# Preferências e caches do app
Linux:   ~/.config/Cloudflare Tunnel Manager/
macOS:   ~/Library/Application Support/Cloudflare Tunnel Manager/
Windows: %APPDATA%\Cloudflare Tunnel Manager\

# Backups
~/cloudflared-backups/cloudflared-AAAAAMMDD-HHMMSS.tar.gz
```

---

## 🩺 Solução de problemas

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| `NXDOMAIN` / o endereço não abre | registro DNS não existe | **Registros DNS** → criar o hostname |
| **502 Bad Gateway** | túnel no ar, mas nada escuta na porta | confira **🔍 Testar conexão**; suba o serviço local |
| **1033 / túnel “offline”** | nenhum conector conectado | **Serviço & Logs → ▶ Iniciar** (e veja os logs) |
| **404** no hostname | rota não está no YAML (ou catch-all 404 pegou) | **Editor de Ingress** → adicionar a rota → reiniciar |
| “domínio não autorizado” | o `cert.pem` cobre outro domínio | **🔑 Reautenticar** e escolher o domínio certo |
| “Credenciais ausentes” | falta o `<uuid>.json` nesta máquina | copie do backup, ou recrie o túnel por aqui |
| “Sem YAML” no cartão | túnel criado em outra máquina | **🩹 Gerar config** no editor |
| “Configuração inválida” ao salvar | YAML recusado na validação | nada foi gravado; corrija conforme a mensagem |
| Serviço não sobe no boot | `linger` desativado (modo usuário) | `loginctl show-user $USER -p Linger` e **🔌 Ativar no boot** de novo |
| Ações pedem senha | modo *sistema* usa `pkexec` | esperado — ou troque para modo *usuário* |
| Rota não aparece no painel da Cloudflare | túnel é **local**, o painel só mostra túneis remotos | [é o comportamento correto](#1-túnel-local--rotas-no-painel-da-cloudflare) |
| “Não foi possível acompanhar os logs” | `journalctl` do sistema exige privilégio | use **📜 Últimas linhas** ou o modo usuário |
| App não abre (Linux) | falta FUSE para o AppImage | `sudo apt install libfuse2t64` ou use `--appimage-extract-and-run` |
| Janela “sumiu” | o app fechou para a bandeja | clique no ⚡ da bandeja, ou reabra o app |

**Diagnóstico em 3 comandos** (Linux, modo usuário):

```bash
systemctl --user status cloudflared-<túnel>        # o serviço está ativo?
journalctl --user -u cloudflared-<túnel> -n 50     # o que ele diz?
cloudflared --config ~/.cloudflared/<túnel>.yml tunnel ingress validate
```

---

## 🔐 Segurança e limites

**O que o app faz para não te quebrar:**

- Valida a configuração **antes** de gravar — arquivo inválido nunca substitui o bom.
- Guarda backup a cada salvamento (5 últimos por túnel).
- Permissões `600` nos arquivos com segredo e `700` em `~/.cloudflared`.
- Confirmação digitada para exclusões e desinstalação.
- Não roda como root: no modo sistema usa `pkexec`/`sudo` só para o `systemctl`.

**O que ele não faz (por design):**

- Não apaga registros DNS ao excluir um túnel (a Cloudflare também não) — limpe no painel se quiser.
- Não gerencia túneis *remotamente gerenciados* (criados no painel com token). Este app é para túneis locais.
- Não guarda suas credenciais em banco próprio: tudo continua em `~/.cloudflared`.
- Não abre portas no seu roteador — o Cloudflare Tunnel é uma conexão de saída.

---

## 🧪 Desenvolvimento e testes

```bash
npm install
npm start            # ou npm run dev (com DevTools)
npm run lint         # sintaxe de todos os .js (usado no CI)
npm test             # back-end: validações, YAML, rollback, backup, CLI real
npm run test:publish # fluxo de subdomínio (dublês) + checagens DNS/HTTP reais
npm run test:services# ciclo de vida real do systemd (unidade descartável)
npm run test:smoke   # sobe o Electron e valida a interface de verdade
npm run test:all     # tudo acima
```

- `test:services` cria uma unidade temporária `cloudflared-ctm-selftest.service` com UUID fictício, exercita enable/start/stop/restart/disable/logs/remove e **limpa tudo** no final.
- `test:publish` nunca toca na sua conta: a parte de mutação usa dublês; só DNS/HTTPS públicos são reais.
- `test:smoke` carrega a interface real no Electron, clica nas telas e falha se houver erro de console.

### Estrutura

```
src/
├── main/                  # processo principal (Node)
│   ├── main.js            # ciclo de vida do Electron, janela, tray
│   ├── context.js         # monta os serviços (usado também pelos testes)
│   ├── ipc.js             # contrato IPC (todo handler devolve {ok, error?})
│   ├── preload.js         # ponte segura para o renderer (window.ctm)
│   ├── cloudflared.js     # CLI: install, login, create, config, DNS, backup
│   ├── cloudflare-api.js  # API do Cloudflare com o token do cert.pem
│   ├── publish.js         # orquestra "criar subdomínio" em etapas
│   ├── checkup.js         # DoH, teste de porta local e de HTTPS público
│   ├── preflight.js       # checagem antes de subir um serviço
│   ├── config.js          # YAML: build/parse/validação/inserção de rotas
│   ├── services.js        # systemd (user/sistema), launchd, serviço do Windows
│   ├── platform.js        # modelo consolidado do dashboard
│   ├── privilege.js       # pkexec → sudo -n → sudo -A (helper gráfico)
│   ├── runner.js          # processos longos (túnel manual, logs ao vivo)
│   ├── settings.js        # preferências em JSON
│   └── paths.js           # ~/.cloudflared, validações, descoberta do binário
├── renderer/              # interface (HTML/CSS/JS puro, sem framework)
scripts/                   # testes, lint, gerador de ícone
assets/                    # ícone do app
.github/workflows/         # build dos instaladores por tag (Release)
```

### Gerar instaladores

```bash
npm run icon         # regenera assets/icon.png (512×512)
npm run dist:linux   # AppImage + deb
npm run dist:mac     # dmg
npm run dist:win     # exe (NSIS)
```

Publicar uma tag `v*` dispara o GitHub Actions, que gera os instaladores dos três sistemas e anexa na Release.

---

## ❓ FAQ

**Preciso de conta paga na Cloudflare?**
Não. O Cloudflare Tunnel (Zero Trust) funciona no plano gratuito para uso pessoal. O domínio precisa estar usando os nameservers da Cloudflare.

**O app substitui o `cloudflared`?**
Não — ele instala e opera o binário oficial. Você pode continuar usando o terminal normalmente; os arquivos são os mesmos.

**Consigo usar o mesmo túnel em duas máquinas?**
Não ao mesmo tempo com o mesmo `<uuid>.json` (o Cloudflare derruba conexões duplicadas). Crie um túnel por máquina.

**Como removo tudo?**
**Configurações → 🧹 Remover todas as unidades** e **🗑 Desinstalar pacote**. Depois apague `~/.cloudflared` se quiser zerar as credenciais — mas isso não apaga os túneis na conta (use o dashboard ou a opção 🗑 Excluir).

**Apaguei um arquivo sem querer!**
O editor mantém os 5 últimos backups: **Editor de Ingress → ↩ Restaurar**.

**O que é o tal `http_status:404` no fim do YAML?**
É o *catch-all*: qualquer requisição que não case com nenhuma rota recebe 404. O Cloudflare exige que a última regra case com tudo — o app sempre mantém isso ao inserir rotas.

---

## 👨‍💻 Autor

**Marcelo Luiz**
🌐 [GitHub](https://github.com/mlluiz39)

Sinta-se à vontade para abrir **issues** ou enviar sugestões! 🚀
