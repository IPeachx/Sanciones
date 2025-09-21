# Bot de Sanciones (Discord.js v14)

## Pasos
1. Instala dependencias: `npm i`
2. Rellena `.env` con `TOKEN`, `CLIENT_ID`, `GUILD_ID`.
3. Completa `config.json` con el canal de logs y los IDs de roles autorizados.
4. Registra comandos: `npm run register`
5. Arranca el bot: `npm run dev`
6. En Discord ejecuta: `/panel-sanciones`

## Roles y permisos
- **sanctionRoles**: pueden sancionar (ver botón Sancionar)
- **annulRoles**: pueden anular sanciones (ver botón Anular)
- **listRoles**: (dos rangos) pueden ver la lista de sanciones

## DMs
- Mensaje distinto para **WARN** y **STRIKE**.
- Mensaje para anulación (apelación aceptada).

## Logs
- Embed color rosita (#FFC0CB) en el canal `logChannelId`, mostrando quién aplicó/anuló y detalles de la sanción.
