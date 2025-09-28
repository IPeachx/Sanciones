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
} from 'discord.js';
import cfg from '../config.json' assert { type: 'json' };

// ====== Persistencia simple en JSON ======
const DATA_PATH =
  process.env.SANCTIONS_PATH ||
  (fs.existsSync('/data') ? '/data/sanctions.json' : path.join(process.cwd(), 'sanctions.json'));

function loadDB() {
  try {
    if (!fs.existsSync(DATA_PATH)) {
      fs.writeFileSync(DATA_PATH, JSON.stringify({ guilds: {} }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  } catch {
    return { guilds: {} };
  }
}

function saveDB(db) {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(db, null, 2));
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

function hasAnyRole(member, roleIds = []) {
  if (!roleIds?.length) return true;
  return member.roles.cache.some(r => roleIds.includes(r.id));
}

function parseUser(input) {
  if (!input) return null;
  // <@123> o <@!123> o simple ID
  const m = input.match(/^<@!?(\d+)>$/);
  return m ? m[1] : input.trim();
}

async function resolveMember(guild, text) {
  const id = parseUser(text);
  if (!id) return null;
  try {
    return await guild.members.fetch(id);
  } catch {
    return null;
  }
}

function nowISO() {
  return new Date().toISOString();
}

function countActive(db, gid, uid) {
  const list = (db.guilds[gid]?.sanctions || []).filter(s => s.active && s.userId === uid);
  return {
    warns: list.filter(s => s.type === 'warn').length,
    strikes: list.filter(s => s.type === 'strike').length,
  };
}

// ====== Embeds ======
function baseEmbed() {
  const e = new EmbedBuilder().setColor(cfg.dmEmbed?.color || '#FFCC8B').setTimestamp(new Date());
  if (cfg.dmEmbed?.logoUrl) e.setThumbnail(cfg.dmEmbed.logoUrl);
  if (cfg.dmEmbed?.imageUrl) e.setImage(cfg.dmEmbed.imageUrl);
  if (cfg.dmEmbed?.footer) e.setFooter({ text: cfg.dmEmbed.footer });
  return e;
}

function dmSanctionEmbed({ type, guildName, reason, authorizedBy, progress, ticket }) {
  const title =
    type === 'warn'
      ? cfg.dmEmbed?.titleWarn || 'Has recibido un WARN'
      : cfg.dmEmbed?.titleStrike || 'Has recibido un STRIKE';
  const e = baseEmbed()
    .setTitle(`📩 ${title}`)
    .setDescription(`En **${guildName}**`)
    .addFields(
      { name: 'Motivo', value: reason || '—', inline: false },
      { name: 'Autorizado por', value: authorizedBy || '—', inline: true }
    );
  if (progress) e.addFields({ name: 'Progreso', value: progress, inline: false });
  if (ticket) e.addFields({ name: 'Ticket', value: String(ticket), inline: true });
  return e;
}

function dmAnnulEmbed({ guildName, type, reason, authorizedBy, ticket }) {
  const e = baseEmbed()
    .setTitle(`🟢 ${cfg.dmEmbed?.titleAnnul || 'Sanción anulada'}`)
    .setDescription(`Tu sanción **${String(type).toUpperCase()}** en **${guildName}** fue **anulada**.`)
    .addFields(
      { name: 'Motivo de anulación', value: reason || '—', inline: false },
      { name: 'Autorizado por', value: authorizedBy || '—', inline: true }
    );
  if (ticket) e.addFields({ name: 'Ticket', value: String(ticket), inline: true });
  return e;
}

function logEmbed({
  title,
  actor,
  target,
  type,
  reason,
  authorizedBy,
  sanctionId,
  extra = [],
}) {
  const e = new EmbedBuilder()
    .setColor(cfg.embedColor || '#FFCC8B')
    .setTitle(title || 'Sanción')
    .setTimestamp(new Date());

  if (cfg.dmEmbed?.logoUrl) e.setThumbnail(cfg.dmEmbed.logoUrl);
  if (cfg.dmEmbed?.imageUrl) e.setImage(cfg.dmEmbed.imageUrl);
  if (cfg.dmEmbed?.footer) e.setFooter({ text: cfg.dmEmbed.footer });

  if (target) e.addFields({ name: 'Usuario', value: `<@${target.id}> (${target.tag})`, inline: false });
  if (type) e.addFields({ name: 'Tipo', value: String(type).toUpperCase(), inline: true });
  if (reason) e.addFields({ name: 'Motivo', value: reason, inline: true });
  if (authorizedBy) e.addFields({ name: 'Autorizado por', value: authorizedBy, inline: true });
  if (actor) e.addFields({ name: 'Sancionado por', value: `<@${actor.id}> (${actor.tag})`, inline: false });
  if (sanctionId) e.addFields({ name: 'ID de Sanción', value: String(sanctionId), inline: false });

  for (const f of extra) e.addFields(f);
  return e;
}

// ====== DM con fallback a log cuando falla ======
async function sendDmAndLog(guild, user, embed, contextTitle, extraLog = {}, logTo = 'sanctions') {
  let delivered = true;
  try {
    const dm = await user.createDM();
    await dm.send({ embeds: [embed] });
  } catch {
    delivered = false;
    const logCh =
      logTo === 'annuls' ? getLogChannelForAnnuls(guild) : getLogChannelForSanctions(guild);
    if (logCh) {
      const e = new EmbedBuilder()
        .setColor('#E67E22')
        .setTitle('✉️ No se pudo enviar DM')
        .setDescription(`No se pudo notificar por DM — ${contextTitle}`)
        .setTimestamp(new Date())
        .addFields({ name: 'Usuario', value: `<@${user.id}> (${user.tag})` });
      if (extraLog?.sanctionId) e.addFields({ name: 'ID', value: String(extraLog.sanctionId) });
      await logCh.send({ embeds: [e] }).catch(() => {});
    }
  }
  return delivered;
}

// ====== STRIKE automático al llegar a 3/3, 6/3, ... ======
async function maybeAddAutoStrike({ db, guild, targetMember, authorizedMember, interaction, ticket }) {
  const gid = guild.id;
  const uid = targetMember.id;

  const { warns } = countActive(db, gid, uid);
  if (warns > 0 && warns % MAX_WARN === 0) {
    const strikeId = `${Date.now()}_${Math.floor(Math.random() * 9999)}`;
    const reason = `Auto-STRIKE por acumular ${MAX_WARN} WARN(s) (los WARN no se consumen).`;

    const strikeRecord = {
      id: strikeId,
      userId: uid,
      userTag: targetMember.user.tag,
      type: 'strike',
      reason,
      authorizedById: authorizedMember?.id ?? interaction.user.id,
      authorizedByTag: authorizedMember?.user?.tag ?? interaction.user.tag,
      issuedById: interaction.user.id,
      issuedByTag: interaction.user.tag,
      ticket: ticket || 'AUTO',
      autoNoConsume: true,
      createdAt: nowISO(),
      active: true,
    };

    db.guilds[gid].sanctions.push(strikeRecord);
    saveDB(db);

    const after = countActive(db, gid, uid);

    // DM
    const dm = dmSanctionEmbed({
      type: 'strike',
      guildName: guild.name,
      reason,
      authorizedBy: strikeRecord.authorizedByTag,
      ticket: strikeRecord.ticket,
      progress: `Warns ${after.warns}/${MAX_WARN} · Strikes ${after.strikes}/${MAX_STRIKE}`,
    });
    await sendDmAndLog(guild, targetMember.user, dm, 'Auto-STRIKE por WARNs', { sanctionId: strikeId });

    // Log a sanciones
    const logCh = getLogChannelForSanctions(guild);
    if (logCh) {
      const e = logEmbed({
        title: '⚠️ Auto STRIKE por WARNs',
        actor: interaction.user,
        target: targetMember.user,
        type: 'strike',
        reason,
        authorizedBy: strikeRecord.authorizedByTag,
        sanctionId: strikeId,
        extra: [
          { name: 'Acumulado', value: `Warns ${after.warns}/${MAX_WARN} · Strikes ${after.strikes}/${MAX_STRIKE}` },
          { name: 'Ticket', value: String(strikeRecord.ticket) },
        ],
      });
      await logCh.send({ embeds: [e] }).catch(() => {});
    }
  }
}

// ====== UI ======
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
    .setTitle(cfg.panelEmbed?.title || 'Panel de sanciones')
    .setColor(cfg.panelEmbed?.color || '#FFCC8B')
    .setDescription(
      [
        '### Botones',
        '• **Sancionar** → Abre formulario para aplicar `WARN` o `STRIKE`.',
        '• **Anular sanción** → Abre formulario para anular una sanción con ticket.',
        '• **Buscar** → Consulta sanciones activas de un usuario.',
        '',
        '### Consejitos',
        '• Antes de usar un botón, obtiene el **ID** del usuario y de quien **autoriza**.',
        '• Escribe correctamente el **motivo**, evita mayúsculas sostenidas.',
        '• Asegúrate de sancionar al **usuario correcto**.',
      ].join('\n')
    )
    .setTimestamp(new Date());
  if (cfg.panelEmbed?.logoUrl) e.setThumbnail(cfg.panelEmbed.logoUrl);
  if (cfg.panelEmbed?.imageUrl) e.setImage(cfg.panelEmbed.imageUrl);
  if (cfg.panelEmbed?.footer) e.setFooter({ text: cfg.panelEmbed.footer });
  return e;
}

// ====== Ready ======
client.once('ready', () => {
  console.log(`✅ Conectado como ${client.user.tag}`);
});

// ====== Interacciones ======
client.on('interactionCreate', async (interaction) => {
  try {
    // /panel-sanciones
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'panel-sanciones') {
        await interaction.reply({ embeds: [panelInfoEmbed()], components: panelComponents() });
      }
      return;
    }

    // Botones
    if (interaction.isButton()) {
      const { guild, member } = interaction;

      if (interaction.customId === 'btn_sancionar') {
        if (!hasAnyRole(member, cfg.sanctionRoles))
          return interaction.reply({ ephemeral: true, content: '⛔ No tienes permisos para sancionar.' });

        const modal = new ModalBuilder().setCustomId('modal_sancionar').setTitle('Sancionar usuario');

        const tiUser = new TextInputBuilder()
          .setCustomId('usuario')
          .setLabel('Usuario a sancionar (mención o ID)')
          .setRequired(true)
          .setStyle(TextInputStyle.Short);

        const tiType = new TextInputBuilder()
          .setCustomId('tipo')
          .setLabel('Tipo (warn o strike)')
          .setRequired(true)
          .setStyle(TextInputStyle.Short);

        const tiMotivo = new TextInputBuilder()
          .setCustomId('motivo')
          .setLabel('Motivo de sanción')
          .setRequired(true)
          .setStyle(TextInputStyle.Paragraph);

        const tiAuth = new TextInputBuilder()
          .setCustomId('autoriza')
          .setLabel('Autorizado por (mención o ID)')
          .setRequired(true)
          .setStyle(TextInputStyle.Short);

        const tiTicket = new TextInputBuilder()
          .setCustomId('ticket')
          .setLabel('Número de Ticket (opcional)')
          .setRequired(false)
          .setStyle(TextInputStyle.Short);

        modal.addComponents(
          new ActionRowBuilder().addComponents(tiUser),
          new ActionRowBuilder().addComponents(tiType),
          new ActionRowBuilder().addComponents(tiMotivo),
          new ActionRowBuilder().addComponents(tiAuth),
          new ActionRowBuilder().addComponents(tiTicket)
        );
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'btn_anular') {
        if (!hasAnyRole(member, cfg.sanctionRoles))
          return interaction.reply({ ephemeral: true, content: '⛔ No tienes permisos para anular.' });

        const modal = new ModalBuilder().setCustomId('modal_anular').setTitle('Anular sanción');

        const tiUser = new TextInputBuilder()
          .setCustomId('usuario')
          .setLabel('Usuario (mención o ID)')
          .setRequired(true)
          .setStyle(TextInputStyle.Short);

        const tiType = new TextInputBuilder()
          .setCustomId('tipo')
          .setLabel('Tipo a anular (warn o strike)')
          .setRequired(true)
          .setStyle(TextInputStyle.Short);

        const tiMotivo = new TextInputBuilder()
          .setCustomId('motivo')
          .setLabel('Motivo de anulación')
          .setRequired(true)
          .setStyle(TextInputStyle.Paragraph);

        const tiAuth = new TextInputBuilder()
          .setCustomId('autoriza')
          .setLabel('Autorizado por (mención o ID)')
          .setRequired(true)
          .setStyle(TextInputStyle.Short);

        const tiTicket = new TextInputBuilder()
          .setCustomId('ticket')
          .setLabel('Número de Ticket (opcional)')
          .setRequired(false)
          .setStyle(TextInputStyle.Short);

        modal.addComponents(
          new ActionRowBuilder().addComponents(tiUser),
          new ActionRowBuilder().addComponents(tiType),
          new ActionRowBuilder().addComponents(tiMotivo),
          new ActionRowBuilder().addComponents(tiAuth),
          new ActionRowBuilder().addComponents(tiTicket)
        );
        return interaction.showModal(modal);
      }

      if (interaction.customId === 'btn_buscar') {
        if (!hasAnyRole(interaction.member, cfg.listRoles))
          return interaction.reply({ ephemeral: true, content: '⛔ No tienes permisos para buscar.' });

        const modal = new ModalBuilder().setCustomId('modal_buscar').setTitle('Buscar sanciones');

        const tiUser = new TextInputBuilder()
          .setCustomId('usuario')
          .setLabel('Usuario (mención o ID)')
          .setRequired(true)
          .setStyle(TextInputStyle.Short);

        modal.addComponents(new ActionRowBuilder().addComponents(tiUser));
        return interaction.showModal(modal);
      }
      return;
    }

    // Modales
    if (interaction.isModalSubmit()) {
      const { guild } = interaction;
      const db = loadDB();
      ensureGuild(db, guild.id);

      // ===== SANCIONAR =====
      if (interaction.customId === 'modal_sancionar') {
        await interaction.deferReply({ ephemeral: true });

        const userText = interaction.fields.getTextInputValue('usuario');
        const typeText = interaction.fields.getTextInputValue('tipo');
        const reason = interaction.fields.getTextInputValue('motivo');
        const authText = interaction.fields.getTextInputValue('autoriza');
        const ticket = interaction.fields.getTextInputValue('ticket')?.trim();

        const targetMember = await resolveMember(guild, userText);
        const authorizedMember = await resolveMember(guild, authText);
        const type = String(typeText || '').toLowerCase().trim();

        if (!targetMember)
          return interaction.editReply('❌ Usuario a sancionar inválido.');
        if (!authorizedMember)
          return interaction.editReply('❌ Usuario que autoriza inválido.');
        if (!['warn', 'strike'].includes(type))
          return interaction.editReply('❌ Tipo inválido. Usa `warn` o `strike`.');

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
          ticket: ticket || undefined,
          createdAt: nowISO(),
          active: true,
        };

        db.guilds[guild.id].sanctions.push(record);
        saveDB(db);

        const c = countActive(db, guild.id, targetMember.id);

        // DM
        const dm = dmSanctionEmbed({
          type,
          guildName: guild.name,
          reason,
          authorizedBy: authorizedMember.user.tag,
          ticket,
          progress: `Warns ${c.warns}/${MAX_WARN} · Strikes ${c.strikes}/${MAX_STRIKE}`,
        });
        await sendDmAndLog(guild, targetMember.user, dm, 'Nueva sanción', { sanctionId });

        // Log (nuevas sanciones)
        const logCh = getLogChannelForSanctions(guild);
        if (logCh) {
          const e = logEmbed({
            title: '📌 Nueva sanción',
            actor: interaction.user,
            target: targetMember.user,
            type,
            reason,
            authorizedBy: authorizedMember.user.tag,
            sanctionId,
            extra: [
              { name: 'Acumulado', value: `Warns ${c.warns}/${MAX_WARN} · Strikes ${c.strikes}/${MAX_STRIKE}` },
              ...(ticket ? [{ name: 'Ticket', value: String(ticket) }] : []),
            ],
          });
          await logCh.send({ embeds: [e] }).catch(() => {});
        }

        // Auto STRIKE si corresponde (al llegar a múltiplo exacto de MAX_WARN)
        if (type === 'warn') {
          await maybeAddAutoStrike({
            db,
            guild,
            targetMember,
            authorizedMember,
            interaction,
            ticket,
          });
        }

        return interaction.editReply('✅ Sanción registrada.');
      }

      // ===== ANULAR =====
      if (interaction.customId === 'modal_anular') {
        await interaction.deferReply({ ephemeral: true });

        const userText = interaction.fields.getTextInputValue('usuario');
        const typeText = interaction.fields.getTextInputValue('tipo');
        const annulReason = interaction.fields.getTextInputValue('motivo');
        const authText = interaction.fields.getTextInputValue('autoriza');
        const ticket = interaction.fields.getTextInputValue('ticket')?.trim();

        const targetMember = await resolveMember(guild, userText);
        const authorizedMember = await resolveMember(guild, authText);
        const type = String(typeText || '').toLowerCase().trim();

        if (!targetMember)
          return interaction.editReply('❌ Usuario inválido.');
        if (!authorizedMember)
          return interaction.editReply('❌ Usuario que autoriza inválido.');
        if (!['warn', 'strike'].includes(type))
          return interaction.editReply('❌ Tipo inválido. Usa `warn` o `strike`.');

        const list = db.guilds[guild.id].sanctions;
        // Buscamos la sanción activa más reciente de ese tipo
        const idx = [...list]
          .reverse()
          .findIndex(s => s.active && s.userId === targetMember.id && s.type === type);

        if (idx === -1)
          return interaction.editReply('⚠️ No hay sanciones activas de ese tipo para ese usuario.');

        const realIndex = list.length - 1 - idx;
        const sanction = list[realIndex];

        sanction.active = false;
        sanction.annulledAt = nowISO();
        sanction.annulledById = interaction.user.id;
        sanction.annulledByTag = interaction.user.tag;
        sanction.annulReason = annulReason || '—';
        if (ticket) sanction.annulTicket = ticket;

        saveDB(db);

        const c = countActive(db, guild.id, targetMember.id);

        // DM
        const dm = dmAnnulEmbed({
          guildName: guild.name,
          type,
          reason: annulReason,
          authorizedBy: authorizedMember.user.tag,
          ticket,
        });
        await sendDmAndLog(guild, targetMember.user, dm, 'Sanción anulada', { sanctionId: sanction.id }, 'annuls');

        // Log a canal de anulaciones
        const logCh = getLogChannelForAnnuls(guild);
        if (logCh) {
          const e = logEmbed({
            title: '🟢 Sanción anulada',
            actor: interaction.user,
            target: targetMember.user,
            type,
            reason: annulReason,
            authorizedBy: authorizedMember.user.tag,
            sanctionId: sanction.id,
            extra: [
              { name: 'Acumulado', value: `Warns ${c.warns}/${MAX_WARN} · Strikes ${c.strikes}/${MAX_STRIKE}` },
              ...(ticket ? [{ name: 'Ticket', value: String(ticket) }] : []),
            ],
          });
          await logCh.send({ embeds: [e] }).catch(() => {});
        }

        return interaction.editReply('✅ Sanción anulada.');
      }

      // ===== BUSCAR =====
      if (interaction.customId === 'modal_buscar') {
        await interaction.deferReply({ ephemeral: true });
        const userText = interaction.fields.getTextInputValue('usuario');
        const member = await resolveMember(guild, userText);
        if (!member) return interaction.editReply('❌ Usuario inválido.');

        const db2 = loadDB();
        const active = (db2.guilds[guild.id]?.sanctions || []).filter(
          s => s.active && s.userId === member.id
        );

        const c = countActive(db2, guild.id, member.id);
        const lines = active
          .slice(-10)
          .map(
            s =>
              `• **${s.type.toUpperCase()}** | Motivo: ${s.reason} | Autoriza: ${s.authorizedByTag} | ID: \`${s.id}\` ${
                s.ticket ? `| Ticket: \`${s.ticket}\`` : ''
              }`
          );

        const e = new EmbedBuilder()
          .setColor(cfg.embedColor || '#FFCC8B')
          .setTitle(`🔎 Sanciones activas de ${member.user.tag}`)
          .setDescription(
            lines.length ? lines.join('\n') : '_Sin sanciones activas_'
          )
          .addFields({
            name: 'Acumulado',
            value: `Warns ${c.warns}/${MAX_WARN} · Strikes ${c.strikes}/${MAX_STRIKE}`,
          })
          .setTimestamp(new Date());

        return interaction.editReply({ embeds: [e] });
      }

      return;
    }
  } catch (e) {
    console.error('Error en interacción:', e);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ ephemeral: true, content: '⚠️ Ocurrió un error.' });
      } catch {}
    }
  }
});

// ====== Login ======
client.login(process.env.TOKEN);
