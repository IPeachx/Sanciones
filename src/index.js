// src/index.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

// ===== Config & DB paths =====
const __dirname = path.resolve();
const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const DB_PATH = process.env.SANCTIONS_PATH || path.join(process.cwd(), 'sanctions.json');

const cfg = loadConfig();
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    // Defaults (in case config.json is missing)
    return {
      logChannelId: '',
      sanctionRoles: [],
      annulRoles: [],
      listRoles: [],
      embedColor: '#FFCC8B',
      limits: { warns: 3, strikes: 7 },
      dmEmbed: {
        color: '#FFCC8B',
        titleWarn: 'Has recibido un WARN',
        titleStrike: 'Has recibido un STRIKE',
        titleAnnul: 'Sanción anulada',
        logoUrl: '',
        imageUrl: '',
        footer: 'Lollipop • Moderation notice',
      },
      listEmbed: {
        title: '📋 Lista de sanciones activas',
        logoUrl: '',
        imageUrl: '',
        footer: 'Panel de Sanciones',
        public: true,
      },
      panelEmbed: {
        title: 'Panel de sanciones | lollipop',
        color: '#FFCC8B',
        logoUrl: '',
        imageUrl: '',
        footer: 'Lollipop | Moderation panel',
      },
    };
  }
}

// ===== DB helpers =====
function loadDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { guilds: {} };
  }
}
function saveDB(db) {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving DB:', e);
  }
}
function ensureGuild(db, guildId) {
  if (!db.guilds[guildId]) db.guilds[guildId] = { sanctions: [] };
}

function nowISO() {
  return new Date().toISOString();
}

function hasAnyRole(member, roleIds = []) {
  if (!roleIds?.length) return true; // if not configured, let it pass
  return member.roles.cache.some(r => roleIds.includes(r.id));
}

function normalizeType(s) {
  const t = String(s || '').trim().toLowerCase();
  if (t.startsWith('w')) return 'warn';
  if (t.startsWith('s')) return 'strike';
  return null;
}

async function resolveMember(guild, text) {
  if (!text) return null;
  const id = (text.match(/\d{15,}/g) || [])[0];
  if (!id) return null;
  try {
    return await guild.members.fetch(id);
  } catch {
    return null;
  }
}

function countWarnsForUser(db, guildId, userId) {
  const arr = db.guilds[guildId]?.sanctions || [];
  return arr.filter(s => s.active && s.userId === userId && s.type === 'warn').length;
}
function countStrikesForUser(db, guildId, userId) {
  const arr = db.guilds[guildId]?.sanctions || [];
  return arr.filter(s => s.active && s.userId === userId && s.type === 'strike').length;
}
function progressString(db, guildId, userId) {
  const warns = countWarnsForUser(db, guildId, userId);
  const strikes = countStrikesForUser(db, guildId, userId);
  return {
    warns,
    strikes,
    label: `Warns ${warns}/${cfg.limits.warns} · Strikes ${strikes}/${cfg.limits.strikes}`,
  };
}

// ===== Embeds =====
function logEmbedBase() {
  const e = new EmbedBuilder()
    .setColor(cfg.embedColor || '#FFCC8B')
    .setTimestamp(new Date());
  if (cfg.listEmbed?.logoUrl) e.setThumbnail(cfg.listEmbed.logoUrl);
  if (cfg.listEmbed?.imageUrl) e.setImage(cfg.listEmbed.imageUrl);
  if (cfg.listEmbed?.footer) e.setFooter({ text: cfg.listEmbed.footer });
  return e;
}

function buildLogNuevaSancion({ targetUser, actor, type, reason, authorizedByTag, sanctionId, warns, strikes, ticket }) {
  const e = logEmbedBase()
    .setTitle('📌 Nueva sanción')
    .addFields(
      { name: 'Usuario', value: `${targetUser} (${targetUser.id})`, inline: false },
      { name: 'Tipo', value: String(type).toUpperCase(), inline: true },
      { name: 'Motivo', value: reason || '—', inline: true },
      { name: 'Autorizado por', value: authorizedByTag || '—', inline: true },
      { name: 'Sancionado por', value: `${actor} (${actor.id})`, inline: false },
      { name: 'ID de Sanción', value: String(sanctionId), inline: false },
      { name: 'Acumulado', value: `Warns ${warns}/${cfg.limits.warns} · Strikes ${strikes}/${cfg.limits.strikes}`, inline: false },
    );
  if (ticket) e.addFields({ name: 'Ticket', value: ticket, inline: false });
  return e;
}

function buildLogAnulacion({ targetUser, actor, type, annulReason, authorizedByTag, sanctionId, warns, strikes, ticket }) {
  const e = logEmbedBase()
    .setTitle('🍀 Sanción anulada')
    .addFields(
      { name: 'Usuario', value: `${targetUser} (${targetUser.id})`, inline: false },
      { name: 'Tipo', value: String(type).toUpperCase(), inline: true },
      { name: 'Motivo de anulación', value: annulReason || '—', inline: true },
      { name: 'Autorizado por', value: authorizedByTag || '—', inline: true },
      { name: 'Anulado por', value: `${actor} (${actor.id})`, inline: false },
      { name: 'ID de Sanción', value: String(sanctionId), inline: false },
      { name: 'Acumulado', value: `Warns ${warns}/${cfg.limits.warns} · Strikes ${strikes}/${cfg.limits.strikes}`, inline: false },
    );
  if (ticket) e.addFields({ name: 'Ticket', value: ticket, inline: false });
  return e;
}

function buildDmSanctionEmbed({ type, guildName, reason, authorizedBy, progress, ticket }) {
  const isWarn = String(type).toLowerCase() === 'warn';
  const title = isWarn ? (cfg.dmEmbed?.titleWarn || 'Has recibido un WARN')
                       : (cfg.dmEmbed?.titleStrike || 'Has recibido un STRIKE');
  const e = new EmbedBuilder()
    .setColor(cfg.dmEmbed?.color || '#FFCC8B')
    .setTitle(title)
    .setDescription(`En **${guildName}**`)
    .addFields(
      { name: 'Motivo', value: reason || '—', inline: false },
      { name: 'Autorizado por', value: authorizedBy || '—', inline: false },
    );
  if (progress) e.addFields({ name: 'Progreso', value: progress, inline: false });
  if (ticket) e.addFields({ name: 'Ticket', value: ticket, inline: false });
  if (cfg.dmEmbed?.logoUrl) e.setThumbnail(cfg.dmEmbed.logoUrl);
  if (cfg.dmEmbed?.imageUrl) e.setImage(cfg.dmEmbed.imageUrl);
  if (cfg.dmEmbed?.footer) e.setFooter({ text: cfg.dmEmbed.footer });
  e.setTimestamp(new Date());
  return e;
}

function buildDmAnnulEmbed({ type, guildName, reason, authorizedBy, progress, ticket }) {
  const e = new EmbedBuilder()
    .setColor(cfg.dmEmbed?.color || '#FFCC8B')
    .setTitle(cfg.dmEmbed?.titleAnnul || 'Sanción anulada')
    .setDescription(`Tu sanción **${String(type).toUpperCase()}** en **${guildName}** fue **anulada**.`)
    .addFields(
      { name: 'Motivo de anulación', value: reason || '—', inline: false },
      { name: 'Autorizado por', value: authorizedBy || '—', inline: false },
    );
  if (progress) e.addFields({ name: 'Progreso', value: progress, inline: false });
  if (ticket) e.addFields({ name: 'Ticket', value: ticket, inline: false });
  if (cfg.dmEmbed?.logoUrl) e.setThumbnail(cfg.dmEmbed.logoUrl);
  if (cfg.dmEmbed?.imageUrl) e.setImage(cfg.dmEmbed.imageUrl);
  if (cfg.dmEmbed?.footer) e.setFooter({ text: cfg.dmEmbed.footer });
  e.setTimestamp(new Date());
  return e;
}

// ===== Client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember],
});

client.once('ready', () => {
  console.log(`✅ Conectado como ${client.user.tag} | PID: ${process.pid}`);
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('uncaughtException', e));

// ===== Components =====
function panelComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_sancionar').setLabel('Sancionar').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_anular').setLabel('Anular sanción').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_buscar').setLabel('Buscar').setStyle(ButtonStyle.Primary),
  );
  return [row];
}

function panelInfoEmbed() {
  const e = new EmbedBuilder()
    .setColor(cfg.panelEmbed?.color || '#FFCC8B')
    .setTitle(cfg.panelEmbed?.title || 'Panel de sanciones')
    .addFields(
      {
        name: 'Botones',
        value:
          `• **Sancionar** → Abre formulario para aplicar \`WARN\` o \`STRIKE\`.\n` +
          `• **Anular sanción** → Abre formulario para anular la sanción de un usuario.\n` +
          `• **Buscar** → Consulta sanciones activas de un usuario.`,
      },
      {
        name: '**Consejitos**',
        value:
          `• Antes de usar un botón, saca el **userID** del usuario y de quien autoriza.\n` +
          `• Escribe correctamente el motivo de la sanción (evita mayúsculas sostenidas).\n` +
          `• Asegúrate de sancionar al usuario correcto.`,
      },
    )
    .setTimestamp(new Date());
  if (cfg.panelEmbed?.logoUrl) e.setThumbnail(cfg.panelEmbed.logoUrl);
  if (cfg.panelEmbed?.imageUrl) e.setImage(cfg.panelEmbed.imageUrl);
  if (cfg.panelEmbed?.footer) e.setFooter({ text: cfg.panelEmbed.footer });
  return e;
}

// ===== Slash commands handling =====
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'panel-sanciones') {
        const member = interaction.member;
        if (
          !hasAnyRole(member, [...(cfg.sanctionRoles || []), ...(cfg.annulRoles || []), ...(cfg.listRoles || [])]) &&
          !member.permissions.has(PermissionFlagsBits.ManageGuild)
        ) {
          return interaction.reply({ ephemeral: true, content: '❌ No tienes permisos para usar el panel.' });
        }
        await interaction.reply({
          embeds: [panelInfoEmbed()],
          components: panelComponents(),
        });
        return;
      }

      if (interaction.commandName === 'lista-sanciones') {
        const isPublic = cfg.listEmbed?.public ?? true;
        await interaction.deferReply(isPublic ? {} : { flags: 64 });

        const db = loadDB();
        ensureGuild(db, interaction.guildId);
        const arr = db.guilds[interaction.guildId].sanctions.filter(s => s.active);

        const lines = [];
        for (const s of arr) {
          const user = await interaction.guild.members.fetch(s.userId).catch(() => null);
          const tag = user?.user?.tag || s.userTag || s.userId;
          const mention = user ? `${user}` : `<@${s.userId}>`;
          lines.push(
            `• **${tag}** (${mention}) | **${s.type.toUpperCase()}** | ` +
            `Motivo: ${s.reason || '—'} | Autorizado: ${s.authorizedByTag || '—'} | ID: \`${s.id}\`` +
            (s.ticket ? ` | Ticket: ${s.ticket}` : '')
          );
        }

        const e = new EmbedBuilder()
          .setColor(cfg.embedColor || '#FFCC8B')
          .setTitle(`${cfg.listEmbed?.title || 'Lista de sanciones activas'}: ${arr.length}`)
          .setDescription(lines.length ? lines.join('\n') : 'No hay sanciones activas.')
          .setTimestamp(new Date());
        if (cfg.listEmbed?.logoUrl) e.setThumbnail(cfg.listEmbed.logoUrl);
        if (cfg.listEmbed?.imageUrl) e.setImage(cfg.listEmbed.imageUrl);
        if (cfg.listEmbed?.footer) e.setFooter({ text: cfg.listEmbed.footer });

        return interaction.editReply({ embeds: [e] });
      }
    }

    // ===== Buttons → open modals =====
    if (interaction.isButton()) {
      if (interaction.customId === 'btn_sancionar') {
        if (!hasAnyRole(interaction.member, cfg.sanctionRoles)) {
          return interaction.reply({ ephemeral: true, content: '❌ No tienes permisos para sancionar.' });
        }

        const modal = new ModalBuilder().setCustomId('modal_sancionar').setTitle('Sancionar usuario');

        const inputUsuario = new TextInputBuilder()
          .setCustomId('usuario').setLabel('Usuario a sancionar (mención o ID)').setStyle(TextInputStyle.Short).setRequired(true);
        const inputTipo = new TextInputBuilder()
          .setCustomId('tipo').setLabel('Tipo (warn o strike)').setStyle(TextInputStyle.Short).setRequired(true);
        const inputMotivo = new TextInputBuilder()
          .setCustomId('motivo').setLabel('Motivo de sanción').setStyle(TextInputStyle.Paragraph).setRequired(true);
        const inputAutoriza = new TextInputBuilder()
          .setCustomId('autoriza').setLabel('Autorizado por (mención o ID)').setStyle(TextInputStyle.Short).setRequired(true);
        const inputTicket = new TextInputBuilder()
          .setCustomId('ticket').setLabel('Número de ticket (opcional)').setStyle(TextInputStyle.Short).setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(inputUsuario),
          new ActionRowBuilder().addComponents(inputTipo),
          new ActionRowBuilder().addComponents(inputMotivo),
          new ActionRowBuilder().addComponents(inputAutoriza),
          new ActionRowBuilder().addComponents(inputTicket),
        );
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'btn_anular') {
        if (!hasAnyRole(interaction.member, cfg.annulRoles)) {
          return interaction.reply({ ephemeral: true, content: '❌ No tienes permisos para anular sanciones.' });
        }

        const modal = new ModalBuilder().setCustomId('modal_anular').setTitle('Anular sanción');

        const inputUsuario = new TextInputBuilder()
          .setCustomId('usuario').setLabel('Usuario (mención o ID)').setStyle(TextInputStyle.Short).setRequired(true);
        const inputTipo = new TextInputBuilder()
          .setCustomId('tipo').setLabel('Tipo (warn o strike)').setStyle(TextInputStyle.Short).setRequired(true);
        const inputMotivo = new TextInputBuilder()
          .setCustomId('motivo').setLabel('Motivo de anulación').setStyle(TextInputStyle.Paragraph).setRequired(true);
        const inputAutoriza = new TextInputBuilder()
          .setCustomId('autoriza').setLabel('Autorizado por (mención o ID)').setStyle(TextInputStyle.Short).setRequired(true);
        const inputTicket = new TextInputBuilder()
          .setCustomId('ticket').setLabel('Número de ticket (opcional)').setStyle(TextInputStyle.Short).setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(inputUsuario),
          new ActionRowBuilder().addComponents(inputTipo),
          new ActionRowBuilder().addComponents(inputMotivo),
          new ActionRowBuilder().addComponents(inputAutoriza),
          new ActionRowBuilder().addComponents(inputTicket),
        );
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'btn_buscar') {
        const modal = new ModalBuilder().setCustomId('modal_buscar').setTitle('Buscar sanciones de un usuario');
        const inputUsuario = new TextInputBuilder()
          .setCustomId('usuario').setLabel('Usuario (mención o ID)').setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(inputUsuario));
        return interaction.showModal(modal);
      }
    }

    // ===== Modal submit: Sancionar =====
    if (interaction.isModalSubmit() && interaction.customId === 'modal_sancionar') {
      const guild = interaction.guild;

      const userText = interaction.fields.getTextInputValue('usuario');
      const typeText = interaction.fields.getTextInputValue('tipo');
      const reason = interaction.fields.getTextInputValue('motivo');
      const authText = interaction.fields.getTextInputValue('autoriza');
      const ticket = (interaction.fields.getTextInputValue('ticket') || '').trim();

      const targetMember = await resolveMember(guild, userText);
      const authorizedMember = await resolveMember(guild, authText);
      const type = normalizeType(typeText);

      if (!targetMember) return interaction.reply({ ephemeral: true, content: '❌ Usuario a sancionar inválido.' });
      if (!authorizedMember) return interaction.reply({ ephemeral: true, content: '❌ Usuario que autoriza inválido.' });
      if (!type) return interaction.reply({ ephemeral: true, content: '❌ Tipo inválido. Usa "warn" o "strike".' });

      const db = loadDB();
      ensureGuild(db, guild.id);

      const sanctionId = `${Date.now()}_${Math.floor(Math.random() * 9999)}`;
      const record = {
        id: sanctionId,
        userId: targetMember.id,
        userTag: targetMember.user.tag,
        type,
        reason,
        authorizedById: authorizedMember.id,
        authorizedByTag: authorizedMember.user.tag,
        issuedById: interaction.user.id,
        issuedByTag: interaction.user.tag,
        createdAt: nowISO(),
        active: true,
        ticket, // NEW
      };
      db.guilds[guild.id].sanctions.push(record);
      saveDB(db);

      // progress after sanction
      const { warns, strikes, label } = progressString(db, guild.id, targetMember.id);

      // DM to user
      const dmEmbed = buildDmSanctionEmbed({
        type,
        guildName: guild.name,
        reason,
        authorizedBy: authorizedMember.user.tag,
        progress: label,
        ticket, // NEW
      });

      const logChannel = guild.channels.cache.get(cfg.logChannelId);
      let dmOk = true;
      try {
        await targetMember.send({ embeds: [dmEmbed] });
      } catch (err) {
        dmOk = false;
        if (logChannel) {
          const warnE = new EmbedBuilder()
            .setColor('#ff5860')
            .setTitle('⚠️ No se pudo enviar DM')
            .setDescription(`No pude enviar el DM a ${targetMember} (${targetMember.id}). Puede tener los DMs cerrados.`)
            .addFields(
              { name: 'Tipo', value: type.toUpperCase(), inline: true },
              { name: 'Ticket', value: ticket || '—', inline: true },
            )
            .setTimestamp(new Date());
          await logChannel.send({ embeds: [warnE] }).catch(() => {});
        }
      }

      // log embed
      try {
        if (logChannel) {
          const logE = buildLogNuevaSancion({
            targetUser: targetMember.user,
            actor: interaction.user,
            type,
            reason,
            authorizedByTag: authorizedMember.user.tag,
            sanctionId,
            warns,
            strikes,
            ticket, // NEW
          });
          await logChannel.send({ embeds: [logE] });
        }
      } catch {}

      return interaction.reply({
        ephemeral: true,
        content: `✅ Sanción **${type.toUpperCase()}** aplicada a ${targetMember}. ` +
          `ID: \`${sanctionId}\` · ${label}` + (dmOk ? '' : ' · ⚠️ DM no enviado'),
      });
    }

    // ===== Modal submit: Anular sanción (última activa del tipo) =====
    if (interaction.isModalSubmit() && interaction.customId === 'modal_anular') {
      const guild = interaction.guild;

      const userText = interaction.fields.getTextInputValue('usuario');
      const typeText = interaction.fields.getTextInputValue('tipo');
      const annulReason = interaction.fields.getTextInputValue('motivo');
      const authText = interaction.fields.getTextInputValue('autoriza');
      const ticket = (interaction.fields.getTextInputValue('ticket') || '').trim();

      const targetMember = await resolveMember(guild, userText);
      const authorizedMember = await resolveMember(guild, authText);
      const type = normalizeType(typeText);

      if (!targetMember) return interaction.reply({ ephemeral: true, content: '❌ Usuario inválido.' });
      if (!authorizedMember) return interaction.reply({ ephemeral: true, content: '❌ Usuario que autoriza inválido.' });
      if (!type) return interaction.reply({ ephemeral: true, content: '❌ Tipo inválido. Usa "warn" o "strike".' });

      const db = loadDB();
      ensureGuild(db, guild.id);

      const arr = db.guilds[guild.id].sanctions;
      const target = [...arr].reverse().find(s => s.active && s.userId === targetMember.id && s.type === type);
      if (!target) {
        return interaction.reply({ ephemeral: true, content: `❌ No encontré sanción activa **${type.toUpperCase()}** para ese usuario.` });
      }

      target.active = false;
      target.annul = {
        reason: annulReason,
        byId: interaction.user.id,
        byTag: interaction.user.tag,
        at: nowISO(),
        ticket, // NEW
      };
      saveDB(db);

      const { warns, strikes, label } = progressString(db, guild.id, targetMember.id);

      // DM notify
      const dmEmbed = buildDmAnnulEmbed({
        type,
        guildName: guild.name,
        reason: annulReason,
        authorizedBy: authorizedMember.user.tag,
        progress: label,
        ticket, // NEW
      });

      const logChannel = guild.channels.cache.get(cfg.logChannelId);
      let dmOk = true;
      try {
        await targetMember.send({ embeds: [dmEmbed] });
      } catch (err) {
        dmOk = false;
        if (logChannel) {
          const warnE = new EmbedBuilder()
            .setColor('#ff5860')
            .setTitle('⚠️ No se pudo enviar DM (anulación)')
            .setDescription(`No pude enviar el DM a ${targetMember} (${targetMember.id}).`)
            .addFields(
              { name: 'Tipo', value: type.toUpperCase(), inline: true },
              { name: 'Ticket', value: target.annul?.ticket || ticket || '—', inline: true },
            )
            .setTimestamp(new Date());
          await logChannel.send({ embeds: [warnE] }).catch(() => {});
        }
      }

      // log embed
      try {
        if (logChannel) {
          const logE = buildLogAnulacion({
            targetUser: targetMember.user,
            actor: interaction.user,
            type,
            annulReason,
            authorizedByTag: authorizedMember.user.tag,
            sanctionId: target.id,
            warns,
            strikes,
            ticket: target.annul?.ticket || ticket, // NEW
          });
          await logChannel.send({ embeds: [logE] });
        }
      } catch {}

      return interaction.reply({
        ephemeral: true,
        content: `✅ Sanción **${type.toUpperCase()}** anulada a ${targetMember}. ` +
          `ID: \`${target.id}\` · ${label}` + (dmOk ? '' : ' · ⚠️ DM no enviado'),
      });
    }

    // ===== Modal submit: Buscar =====
    if (interaction.isModalSubmit() && interaction.customId === 'modal_buscar') {
      const userText = interaction.fields.getTextInputValue('usuario');
      const member = await resolveMember(interaction.guild, userText);
      if (!member) return interaction.reply({ ephemeral: true, content: '❌ Usuario inválido.' });

      const db = loadDB();
      ensureGuild(db, interaction.guildId);
      const arr = db.guilds[interaction.guildId].sanctions.filter(s => s.active && s.userId === member.id);

      const { warns, strikes, label } = progressString(db, interaction.guildId, member.id);
      const lines = arr.map(s =>
        `• **${s.type.toUpperCase()}** | Motivo: ${s.reason || '—'} | Autorizado: ${s.authorizedByTag || '—'} | ` +
        `ID: \`${s.id}\`${s.ticket ? ` | Ticket: ${s.ticket}` : ''}`
      );

      const e = new EmbedBuilder()
        .setColor(cfg.embedColor || '#FFCC8B')
        .setTitle(`Sanciones de ${member.user.tag}`)
        .setDescription(lines.length ? lines.join('\n') : 'Sin sanciones activas.')
        .addFields({ name: 'Progreso', value: label })
        .setTimestamp(new Date());
      if (cfg.listEmbed?.logoUrl) e.setThumbnail(cfg.listEmbed.logoUrl);
      if (cfg.listEmbed?.imageUrl) e.setImage(cfg.listEmbed.imageUrl);
      if (cfg.listEmbed?.footer) e.setFooter({ text: cfg.listEmbed.footer });

      return interaction.reply({ ephemeral: true, embeds: [e] });
    }
  } catch (err) {
    console.error('interaction error', err);
    if (interaction.deferred || interaction.replied) {
      interaction.followUp({ ephemeral: true, content: '❌ Ocurrió un error.' }).catch(() => {});
    } else {
      interaction.reply({ ephemeral: true, content: '❌ Ocurrió un error.' }).catch(() => {});
    }
  }
});

// ===== Login =====
client.login(process.env.TOKEN);
