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
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
  Events,
} from 'discord.js';

// ====== Rol único para TODO el panel (3 botones y comandos) ======
const ROLE_ALLOWED_PANEL = '1404587368262008862'.trim(); // ← tu rol

// ====== Comando por texto para enviar el panel ======
const TEXT_COMMAND = '!panel-sancion';

// ====== Config desde .env ======
const cfg = {
  guildId: process.env.GUILD_ID,
  logChannelId: process.env.LOG_CHANNEL_ID,
  logSanctionsChannelId: process.env.LOG_SANCTIONS_CHANNEL_ID,
  logAnnulsChannelId: process.env.LOG_ANNULS_CHANNEL_ID,
  dmEmbed: {
    color: process.env.DM_COLOR || '#FFCC8B',
    logoUrl: process.env.DM_LOGO_URL || '',
    imageUrl: process.env.DM_IMAGE_URL || '',
    footer: process.env.DM_FOOTER || 'Lollipop RP',
  },
  panelEmbed: {
    title: process.env.PANEL_TITLE || 'Panel de sanciones • Lollipop',
    color: process.env.PANEL_COLOR || '#FFC0CB', // rosita claro
    footer: process.env.PANEL_FOOTER || 'Solo Staff autorizado',
  },
  limits: {
    warns: parseInt(process.env.LIMIT_WARN ?? '3', 10),
    strikes: parseInt(process.env.LIMIT_STRIKE ?? '7', 10),
  },
};

const DATA_PATH = path.join(process.cwd(), 'data.json');

// ====== Persistencia simple ======
function loadDB() {
  try {
    if (!fs.existsSync(DATA_PATH)) return { guilds: {} };
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch (e) {
    console.error('Error cargando DB:', e);
    return { guilds: {} };
  }
}
function saveDB(db) {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('Error guardando DB:', e);
  }
}
function ensureGuild(db, gid) {
  db.guilds ||= {};
  db.guilds[gid] ||= { sanctions: [] };
}

// ====== Cliente ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ====== Utilidades ======
const MAX_WARN = cfg?.limits?.warns ?? 3;
const MAX_STRIKE = cfg?.limits?.strikes ?? 7;

function getLogChannelForSanctions(guild) {
  const id = cfg.logSanctionsChannelId || cfg.logChannelId;
  return id ? guild.channels.cache.get(id) : null;
}
function getLogChannelForAnnuls(guild) {
  const id = cfg.logAnnulsChannelId || cfg.logChannelId;
  return id ? guild.channels.cache.get(id) : null;
}
function parseUser(input) {
  if (!input) return null;
  const m = input.match(/<@!?(\d+)>/) || input.match(/^(\d{10,20})$/);
  return m ? m[1] : null;
}
function getCurrentCounts(db, gid, uid) {
  const list = (db.guilds[gid]?.sanctions || []).filter(s => s.userId === uid);
  return {
    warns: list.filter(s => s.active && s.type === 'warn').length,
    strikes: list.filter(s => s.active && s.type === 'strike').length,
  };
}

// 🔐 Helper: valida el rol del panel (mismo para los 3 botones y modals)
async function ensureHasPanelRole(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ ephemeral: true, content: 'Este panel solo funciona en servidores.' });
    return false;
  }
  const role = interaction.guild.roles.cache.get(ROLE_ALLOWED_PANEL);
  if (!role) {
    await interaction.reply({
      ephemeral: true,
      content: '⚠️ Config: el rol configurado para el panel no existe en este servidor.',
    });
    return false;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.reply({ ephemeral: true, content: 'No pude verificar tus permisos (miembro no encontrado).' });
    return false;
  }
  const ok = member.roles.cache.has(ROLE_ALLOWED_PANEL);
  if (!ok) {
    await interaction.reply({ ephemeral: true, content: '⛔ No tienes permisos para usar este panel.' });
    return false;
  }
  return true;
}

// ====== Embeds/UI ======
function baseEmbed() {
  const e = new EmbedBuilder().setColor(cfg.dmEmbed?.color || '#FFCC8B').setTimestamp(new Date());
  if (cfg.dmEmbed?.logoUrl) e.setThumbnail(cfg.dmEmbed.logoUrl);
  if (cfg.dmEmbed?.imageUrl) e.setImage(cfg.dmEmbed.imageUrl);
  if (cfg.dmEmbed?.footer) e.setFooter({ text: cfg.dmEmbed.footer });
  return e;
}
function panelComponents() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_sancionar').setLabel('Sancionar').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_anular').setLabel('Anular sanción').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_buscar').setLabel('Buscar').setStyle(ButtonStyle.Primary)
  );
  return [row];
}
function panelInfoEmbed() {
  const e = new EmbedBuilder()
    .setTitle(cfg.panelEmbed?.title || 'Panel de sanciones • Lollipop')
    .setColor(cfg.panelEmbed?.color || '#FFC0CB')
    .setDescription(
      [
        '### Botones',
        '• **Sancionar** → Abre formulario para aplicar `WARN` o `STRIKE`.',
        '• **Anular sanción** → Abre formulario para anular la sanción de un usuario.',
        '• **Buscar** → Consulta sanciones activas de un usuario.',
        '',
        '### Consejitos',
        '• Antes de usar un botón, saca el **userID** del usuario y de quien autoriza.',
        '• Escribe correctamente el **motivo** de la sanción (evita mayúsculas sostenidas).',
        '• Asegúrate de sancionar al usuario correcto.',
      ].join('\n')
    )
    .setTimestamp(new Date());
  if (cfg.dmEmbed?.logoUrl) e.setThumbnail(cfg.dmEmbed.logoUrl);
  if (cfg.dmEmbed?.imageUrl) e.setImage(cfg.dmEmbed.imageUrl);
  if (cfg.dmEmbed?.footer) e.setFooter({ text: cfg.dmEmbed.footer });
  return e;
}

// ====== Ready ======
client.once(Events.ClientReady, () => {
  console.log(`✅ Conectado como ${client.user.tag}`);
});

// ====== Interacciones ======
client.on('interactionCreate', async (interaction) => {
  try {
    // Slash opcional: /panel-sanciones
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'panel-sanciones') {
        if (!(await ensureHasPanelRole(interaction))) return;
        await interaction.channel.send({ embeds: [panelInfoEmbed()], components: panelComponents() });
        return interaction.reply({ ephemeral: true, content: '✅ Panel enviado.' });
      }
      return;
    }

    // Botones (los 3 usan EL MISMO permiso)
    if (interaction.isButton()) {
      // SANCIONAR
      if (interaction.customId === 'btn_sancionar') {
        if (!(await ensureHasPanelRole(interaction))) return;

        const modal = new ModalBuilder().setCustomId('modal_sancionar').setTitle('Aplicar sanción');
        const tiUser   = new TextInputBuilder().setCustomId('usuario').setLabel('Usuario (mención o ID)').setStyle(TextInputStyle.Short).setRequired(true);
        const tiType   = new TextInputBuilder().setCustomId('tipo').setLabel('Tipo (warn o strike)').setStyle(TextInputStyle.Short).setRequired(true);
        const tiReason = new TextInputBuilder().setCustomId('motivo').setLabel('Motivo').setStyle(TextInputStyle.Paragraph).setRequired(true);
        const tiAuth   = new TextInputBuilder().setCustomId('autor').setLabel('Staff que autoriza (mención o ID)').setStyle(TextInputStyle.Short).setRequired(true);
        const tiTicket = new TextInputBuilder().setCustomId('ticket').setLabel('Número de ticket').setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(
          new ActionRowBuilder().addComponents(tiUser),
          new ActionRowBuilder().addComponents(tiType),
          new ActionRowBuilder().addComponents(tiReason),
          new ActionRowBuilder().addComponents(tiAuth),
          new ActionRowBuilder().addComponents(tiTicket),
        );
        return interaction.showModal(modal);
      }

      // ANULAR — por TIPO (sin ticket)
      if (interaction.customId === 'btn_anular') {
        if (!(await ensureHasPanelRole(interaction))) return;

        const modal = new ModalBuilder().setCustomId('modal_anular').setTitle('Anular sanción');

        const tiUser = new TextInputBuilder()
          .setCustomId('usuario')
          .setLabel('Usuario (mención o ID)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const tiType = new TextInputBuilder()
          .setCustomId('tipo')
          .setLabel('Tipo de sanción a anular (warn o strike)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const tiReason = new TextInputBuilder()
          .setCustomId('motivo')
          .setLabel('Motivo de anulación')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        const tiAuth = new TextInputBuilder()
          .setCustomId('autor')
          .setLabel('Staff que autoriza (mención o ID)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(tiUser),
          new ActionRowBuilder().addComponents(tiType),
          new ActionRowBuilder().addComponents(tiReason),
          new ActionRowBuilder().addComponents(tiAuth),
        );

        return interaction.showModal(modal);
      }

      // BUSCAR
      if (interaction.customId === 'btn_buscar') {
        if (!(await ensureHasPanelRole(interaction))) return;

        const modal = new ModalBuilder().setCustomId('modal_buscar').setTitle('Buscar sanciones');
        const tiUser = new TextInputBuilder().setCustomId('usuario').setLabel('Usuario (mención o ID)').setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(tiUser));
        return interaction.showModal(modal);
      }
      return;
    }

    // ====== Modals submit ======
    if (interaction.isModalSubmit()) {
      const db = loadDB();
      if (!interaction.inGuild()) {
        return interaction.reply({ ephemeral: true, content: 'Solo en servidores.' });
      }
      const gid = interaction.guildId;

      // ====== APLICAR SANCIÓN ======
      if (interaction.customId === 'modal_sancionar') {
        if (!(await ensureHasPanelRole(interaction))) return;

        const rawUser  = interaction.fields.getTextInputValue('usuario')?.trim();
        const tipo     = interaction.fields.getTextInputValue('tipo')?.trim().toLowerCase();
        const motivo   = interaction.fields.getTextInputValue('motivo')?.trim();
        const autorRaw = interaction.fields.getTextInputValue('autor')?.trim();
        const ticketRaw= interaction.fields.getTextInputValue('ticket')?.trim();

        const uid = parseUser(rawUser);
        const aid = parseUser(autorRaw);
        const ticket = ticketRaw?.replace(/[^\d]/g, '');

        if (!uid || !['warn', 'strike'].includes(tipo) || !motivo || !aid || !ticket) {
          return interaction.reply({ ephemeral: true, content: '⚠️ Datos inválidos. Revisa usuario/tipo/motivo/autor/ticket.' });
        }

        ensureGuild(db, gid);

        const record = {
          type: tipo,
          userId: uid,
          reason: motivo,
          authorId: aid,
          ticket,
          active: true,
          createdAt: Date.now(),
          logMessageId: null,
        };
        db.guilds[gid].sanctions.push(record);

        // Auto STRIKE al llegar a MAX_WARN (sin consumir warns)
        const countsBefore = getCurrentCounts(db, gid, uid);
        if (tipo === 'warn' && countsBefore.warns >= MAX_WARN) {
          db.guilds[gid].sanctions.push({
            type: 'strike',
            userId: uid,
            reason: `Acumulación de ${MAX_WARN} warns`,
            authorId: aid,
            ticket,
            active: true,
            createdAt: Date.now(),
            logMessageId: null,
          });
        }

        // ===== Conteo actual (después de registrar y posible auto-strike)
        const post = getCurrentCounts(db, gid, uid);

        // LOG a canal específico de sanciones + guardar msg.id (incluye Acumulación)
        try {
          const ch = getLogChannelForSanctions(interaction.guild);
          if (ch) {
            const e = baseEmbed()
              .setTitle('✅ Sanción aplicada')
              .setFields(
                { name: 'Usuario', value: `<@${uid}> (\`${uid}\`)`, inline: true },
                { name: 'Tipo', value: record.type.toUpperCase(), inline: true },
                { name: 'Motivo', value: record.reason || '—' },
                { name: 'Autoriza', value: `<@${aid}> (\`${aid}\`)`, inline: true },
                { name: 'Ticket', value: String(record.ticket), inline: true },
                { name: 'Acumulación', value: `Warns ${post.warns}/${MAX_WARN} · Strikes ${post.strikes}/${MAX_STRIKE}` },
              );

            const msg = await ch.send({ embeds: [e] }).catch(() => null);
            if (msg?.id) {
              const list = db.guilds[gid].sanctions;
              list[list.length - 1].logMessageId = msg.id;
            }
          }
        } catch {}

        // DM al usuario sancionado (incluye Acumulación)
        try {
          const eDM = baseEmbed()
            .setTitle('Has recibido una sanción')
            .setDescription(
              [
                `**Tipo:** ${record.type.toUpperCase()}`,
                `**Motivo:** ${record.reason}`,
                `**Ticket:** ${record.ticket}`,
                `**Staff:** <@${aid}>`,
                '',
                `**Acumulación:** Warns ${post.warns}/${MAX_WARN} · Strikes ${post.strikes}/${MAX_STRIKE}`,
              ].join('\n')
            );

          const u = await client.users.fetch(uid).catch(() => null);
          if (u) await u.send({ embeds: [eDM] }).catch(() => {});
        } catch {}

        saveDB(db);

        return interaction.reply({
          ephemeral: true,
          content: `✅ Sanción registrada.\nWarns: ${post.warns}/${MAX_WARN} • Strikes: ${post.strikes}/${MAX_STRIKE}`,
        });
      }

      // ====== ANULAR SANCIÓN — por TIPO (sin ticket) ======
      if (interaction.customId === 'modal_anular') {
        if (!(await ensureHasPanelRole(interaction))) return;

        const rawUser  = interaction.fields.getTextInputValue('usuario')?.trim();
        const rawType  = interaction.fields.getTextInputValue('tipo')?.trim().toLowerCase();
        const motivo   = interaction.fields.getTextInputValue('motivo')?.trim();
        const autorRaw = interaction.fields.getTextInputValue('autor')?.trim();

        const uid  = parseUser(rawUser);
        const aid  = parseUser(autorRaw);
        const tipo = rawType === 'warn' || rawType === 'strike' ? rawType : null;

        if (!uid || !tipo || !motivo || !aid) {
          return interaction.reply({
            ephemeral: true,
            content: '⚠️ Datos inválidos. Revisa usuario/tipo (warn/strike)/motivo/autor.',
          });
        }

        ensureGuild(db, gid);
        const list = db.guilds[gid].sanctions || [];

        // última sanción ACTIVA de ese tipo para ese usuario
        const target = list
          .filter(s => s.userId === uid && s.type === tipo && s.active)
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          .pop();

        if (!target) {
          return interaction.reply({
            ephemeral: true,
            content: '⚠️ No se encontró una sanción activa de ese TIPO para ese usuario.',
          });
        }

        // marcar anulación
        target.active = false;
        target.annulReason = motivo;
        target.annulAuthorId = aid;
        target.annulAt = Date.now();

        // 1) Borrar el mensaje de log de la sanción (si lo tenemos)
        try {
          const chSanctions = getLogChannelForSanctions(interaction.guild);
          if (chSanctions && target.logMessageId) {
            const msg = await chSanctions.messages.fetch(target.logMessageId).catch(() => null);
            if (msg) await msg.delete().catch(() => {});
          }
        } catch {}

        // ===== Conteo actual (después de anular)
        const postAfter = getCurrentCounts(db, gid, uid);

        // 2) Enviar LOG de anulación a su canal específico (incluye Acumulación)
        try {
          const chAnnuls = getLogChannelForAnnuls(interaction.guild);
          if (chAnnuls) {
            const e = baseEmbed()
              .setTitle('♻️ Sanción anulada')
              .setFields(
                { name: 'Usuario', value: `<@${target.userId}> (\`${target.userId}\`)`, inline: true },
                { name: 'Tipo', value: target.type.toUpperCase(), inline: true },
                ...(target.ticket ? [{ name: 'Ticket', value: String(target.ticket), inline: true }] : []),
                { name: 'Motivo original', value: target.reason || '—' },
                { name: 'Autoriza', value: `<@${aid}> (\`${aid}\`)` },
                { name: 'Motivo de anulación', value: motivo || '—' },
                { name: 'Acumulación', value: `Warns ${postAfter.warns}/${MAX_WARN} · Strikes ${postAfter.strikes}/${MAX_STRIKE}` },
              );
            await chAnnuls.send({ embeds: [e] }).catch(() => {});
          }
        } catch {}

        // 3) DM al usuario avisando la anulación (incluye Acumulación)
        try {
          const eDM = baseEmbed()
            .setTitle('Tu sanción ha sido anulada')
            .setDescription(
              [
                `**Tipo:** ${target.type.toUpperCase()}`,
                ...(target.ticket ? [`**Ticket:** ${target.ticket}`] : []),
                `**Motivo de anulación:** ${motivo}`,
                `**Staff:** <@${aid}>`,
                '',
                `**Acumulación:** Warns ${postAfter.warns}/${MAX_WARN} · Strikes ${postAfter.strikes}/${MAX_STRIKE}`,
              ].join('\n')
            );
          const u = await client.users.fetch(uid).catch(() => null);
          if (u) await u.send({ embeds: [eDM] }).catch(() => {});
        } catch {}

        saveDB(db);
        return interaction.reply({ ephemeral: true, content: '♻️ Sanción anulada correctamente.' });
      }

      // ====== BUSCAR ======
      if (interaction.customId === 'modal_buscar') {
        if (!(await ensureHasPanelRole(interaction))) return;

        const rawUser = interaction.fields.getTextInputValue('usuario')?.trim();
        const uid = parseUser(rawUser);
        if (!uid) {
          return interaction.reply({ ephemeral: true, content: '⚠️ Usuario inválido.' });
        }

        ensureGuild(db, gid);
        const list = (db.guilds[gid].sanctions || []).filter(s => s.userId === uid);

        if (!list.length) {
          return interaction.reply({ ephemeral: true, content: '🔎 Sin resultados.' });
        }

        const activeWarns = list.filter(s => s.active && s.type === 'warn').length;
        const activeStrikes = list.filter(s => s.active && s.type === 'strike').length;

        const e = baseEmbed()
          .setTitle('🔎 Resultado de búsqueda')
          .setDescription(`Usuario: <@${uid}> (\`${uid}\`)`)
          .addFields(
            { name: 'Warns activos', value: `${activeWarns}/${MAX_WARN}`, inline: true },
            { name: 'Strikes activos', value: `${activeStrikes}/${MAX_STRIKE}`, inline: true },
            {
              name: 'Historial',
              value: list.slice(-10).map(s =>
                `• **${s.type.toUpperCase()}** — Ticket \`${s.ticket}\` — ${s.active ? 'Activo' : 'Anulado'}`
              ).join('\n') || '—'
            }
          );
        return interaction.reply({ ephemeral: true, embeds: [e] });
      }

      return; // cierre de isModalSubmit
    }
  } catch (e) {
    console.error('Error en interacción:', e);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ ephemeral: true, content: '⚠️ Ocurrió un error.' }); } catch {}
    }
  }
});

// ====== Comando por texto: !panel-sancion (mismo rol) ======
client.on('messageCreate', async (message) => {
  try {
    if (!message.guild || message.author.bot) return;

    const msg = message.content.toLowerCase().replace(/\s+/g, ' ').trim();
    if (msg !== TEXT_COMMAND) return;

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;

    if (!member.roles.cache.has(ROLE_ALLOWED_PANEL)) {
      return message.reply('⛔ No tienes permisos para enviar el panel.');
    }
    if (!message.channel.isTextBased()) {
      return message.reply('⚠️ Este canal no permite enviar el panel.');
    }

    await message.channel.send({ embeds: [panelInfoEmbed()], components: panelComponents() });
    return message.reply('✅ Panel enviado.');
  } catch (e) {
    console.error('Error en !panel-sancion:', e);
    try { await message.reply('⚠️ Ocurrió un error al enviar el panel.'); } catch {}
  }
});

// ====== Login ======
if (!process.env.TOKEN) {
  console.error('❌ Falta TOKEN en el .env');
  process.exit(1);
}
client.login(process.env.TOKEN);
