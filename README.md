# Rhythm Bot

Bot do Discord que toca faixas do Deezer e streams de rádio em canais de voz.

## Pré-requisitos

- Node.js 22.12+
- pnpm
- Uma aplicação criada no [Discord Developer Portal](https://discord.com/developers/applications)

## Configuração

### 1. Crie o bot no Discord Developer Portal

1. Acesse o [Discord Developer Portal](https://discord.com/developers/applications) e crie uma nova aplicação.
2. No menu lateral, vá em **Bot** e clique em **Add Bot**.
3. Copie o **Token** do bot (guarde com segurança).
4. Na aba **OAuth2 > General**, copie o **Client ID** da aplicação.

### 2. Configure as variáveis de ambiente

Copie o arquivo de exemplo e preencha com suas credenciais:

```bash
cp .env.example .env
```

Edite o `.env`:

```env
DISCORD_TOKEN=seu_token_aqui
CLIENT_ID=id_da_aplicacao_aqui
DEEZER_ARL=sua_cookie_arl_do_deezer_aqui
```

Observação: se aparecer `VALID_TOKEN_REQUIRED` ou `Invalid CSRF token`, o valor de `DEEZER_ARL` expirou e precisa ser atualizado.

### 3. Instale as dependências

```bash
pnpm install
```

O projeto usa `opusscript` como fallback puro em JavaScript, então a instalação não depende do build nativo de `@discordjs/opus` no Windows.

## Adicionando o bot ao servidor

Gere o link de convite substituindo `SEU_CLIENT_ID` pelo valor do seu `.env`:

```
https://discord.com/oauth2/authorize?client_id=SEU_CLIENT_ID&permissions=3145728&scope=bot+applications.commands
```

Abra o link no browser, selecione o servidor e clique em **Autorizar**.

As permissões incluídas são:
- **Connect** — entrar em canais de voz
- **Speak** — reproduzir áudio no canal

## Rodando o bot

**Modo desenvolvimento:**

```bash
pnpm dev
```

**Modo produção:**

```bash
pnpm build
pnpm start
```

Quando iniciado, o bot registra automaticamente os slash commands e exibe a mensagem `Pronto! Logado como <nome do bot>`.

## Comandos

| Comando | Descrição |
|---------|-----------|
| `/play <url ou busca>` | Toca uma faixa do Deezer no canal de voz em que você está |
| `/radio` | Exibe as rádios disponíveis para tocar ao vivo no canal de voz |
| `/stop` | Para a reprodução e desconecta o bot do canal de voz |
