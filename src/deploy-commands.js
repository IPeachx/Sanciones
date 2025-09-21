import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('panel-sanciones')
    .setDescription('Publica el panel con botones de Sancionar / Anular / Buscar')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // opcional (solo gente con Manage Server lo ve)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('lista-sanciones')
    .setDescription('Muestra las sanciones activas (solo staff autorizado)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // opcional (el bot igual valida tus listRoles)
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log('🛠️  Registrando comandos...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands },
    );
    console.log('✅  Comandos registrados.');
  } catch (error) {
    console.error(error);
  }
})();