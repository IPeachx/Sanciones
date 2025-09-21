import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';

import cfg from '../config.json' with { type: 'json' };

// ===== Client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Conectado como ${c.user.tag} | PID: ${process.pid}`);
});

// ===== "BD" local =====
const DB_PATH = process.env.SANCTIONS_PATH || path.join(process.cwd(), 'sanctions.json');
function loadDB() { try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return { guilds: {} }; } }
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function nowISO() { return new Date().toISOString(); }
function ensureGuild(db, guildId) { if (!db.guilds[guildId]) db.guilds[guildId] = { sanctions: [] }; }
function hasAnyRole(member, roles) { return roles?.some(r => member.roles.cache.has(r)); }

// ===== Límites (config.json) =====
const MAX_WARN = cfg.limits?.warns ?? 3;
const MAX_STRIKE = cfg.limits?.strikes ?? 7;

function countActiveSanctions(db, guildId, userId) {
  const g = db.guilds[guildId];
  if (!g) return { warns: 0, strikes: 0 };
  return {
    warns: g.sanctions.filter(s => s.active && s.userId === userId && s.type === 'warn').length,
    strikes: g.sanctions.filter(s => s.active && s.userId === userId && s.type === 'strike').length
  };
}

// ===== DM Embeds =====
function buildDmSanctionEmbed({ type, guildName, reason, authorizedBy, warns, strikes }) {
  const isWarn = type === 'warn';
  const title = isWarn
    ? (cfg.dmEmbed?.titleWarn || 'Has recibido un WARN')
    : (cfg.dmEmbed?.titleStrike || 'Has recibido un STRIKE');

  const e = new EmbedBuilder()
    .setColor(cfg.dmEmbed?.color || cfg.embedColor || '#FFC0CB')
    .setTitle(title)
    .setDescription(`En **${guildName}**`)
    .addFields(
      { name: 'Motivo', value: reason || '—', inline: false },
      { name: 'Autorizado por', value: authorizedBy || '—', inline: false },
      { name: 'Progreso', value: `Warns ${warns}/${MAX_WARN} • Strikes ${strikes}/${MAX_STRIKE}` }
    )
    .setTimestamp(new Date());
  if (cfg.dmEmbed?.logoUrl) e.setThumbnail(cfg.dmEmbed.logoUrl);
  if (cfg.dmEmbed?.imageUrl) e.setImage(cfg.dmEmbed.imageUrl);
  if (cfg.dmEmbed?.footer) e.setFooter({ text: cfg.dmEmbed.footer });
  return e;
}

function buildDmAnnulEmbed({ type, guildName, reason, authorizedBy, warns, strikes }) {
  const e = new EmbedBuilder()
    .setColor(cfg.dmEmbed?.color || cfg.embedColor || '#FFC0CB')
    .setTitle(cfg.dmEmbed?.titleAnnul || 'Sanción anulada')
    .setDescription(`Tu sanción **${String(type || '').toUpperCase()}** en **${guildName}** fue **anulada**.`)
    .addFields(
      { name: 'Motivo de anulación', value: reason || '—', inline: false },
      { name: 'Autorizado por', value: authorizedBy || '—', inline: false },
      { name: 'Progreso', value: `Warns ${warns}/${MAX_WARN} • Strikes ${strikes}/${MAX_STRIKE}` }
    )
    .setTimestamp(new Date());
  if (cfg.dmEmbed?.logoUrl) e.setThumbnail(cfg.dmEmbed.logoUrl);
  if (cfg.dmEmbed?.imageUrl) e.setImage(cfg.dmEmbed.imageUrl);
  if (cfg.dmEmbed?.footer) e.setFooter({ text: cfg.dmEmbed.footer });
  return e;
}

// ===== Logs =====
function logEmbed({ title, actor, target, type, reason, authorizedBy, sanctionId }) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(cfg.embedColor || '#FFC0CB')
    .addFields(
      { name: 'Usuario', value: `${target} (${target.id})`, inline: false },
      { name: 'Tipo', value: String(type || '').toUpperCase(), inline: true },
      { name: 'Motivo', value: reason || '—', inline: true },
      { name: 'Autorizado por', value: authorizedBy || '—', inline: true },
      { name: 'Sancionado por', value: `${actor} (${actor.id})`, inline: false },
      { name: 'ID de Sanción', value: sanctionId || '—', inline: true }
    )
    .setTimestamp(new Date());
}
function annulLogEmbed({ title, actor, target, type, reason, authorizedBy, sanctionId }) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(cfg.embedColor || '#FFC0CB')
    .addFields(
      { name: 'Usuario', value: `${target} (${target.id})`, inline: false },
      { name: 'Tipo', value: String(type || '').toUpperCase(), inline: true },
      { name: 'Motivo de anulación', value: reason || '—', inline: true },
      { name: 'Autorizado por', value: authorizedBy || '—', inline: true },
      { name: 'Anulado por', value: `${actor} (${actor.id})`, inline: false },
      { name: 'ID de Sanción', value: sanctionId || '—', inline: true }
    )
    .setTimestamp(new Date());
}

// ===== DM helper (loguea si no se pudo enviar) =====
const LOG_DM_SENT_SUCCESS = false;
/**
 * Envía un DM y escribe en el canal de logs si falla (o si LOG_DM_SENT_SUCCESS=true).
 * @param {Guild} guild
 * @param {User} user
 * @param {EmbedBuilder} embed
 * @param {string} contexto
 * @param {object} extra      // p.ej. { sanctionId }
 * @returns {Promise<boolean>} true si se envió, false si falló
 */
async function sendDmAndLog(guild, user, embed, contexto, extra = {}) {
  const logChannel = guild.channels.cache.get(cfg.logChannelId);
  try {
    await user.send({ embeds: [embed] });
    if (LOG_DM_SENT_SUCCESS && logChannel) {
      const ok = new EmbedBuilder()
        .setColor(cfg.embedColor || '#FFC0CB')
        .setTitle('📩 DM enviado')
        .addFields(
          { name: 'Usuario', value: `${user} • ${user.tag}\nID: ${user.id}` },
          { name: 'Contexto', value: `${contexto}${extra.sanctionId ? ` (ID ${extra.sanctionId})` : ''}` }
        )
        .setTimestamp(new Date());
      await logChannel.send({ embeds: [ok] });
    }
    return true;
  } catch (error) {
    if (logChannel) {
      const fail = new EmbedBuilder()
        .setColor(cfg.embedColor || '#FFC0CB')
        .setTitle('📪 No se pudo enviar DM')
        .addFields(
          { name: 'Usuario', value: `${user} • ${user.tag}\nID: ${user.id}` },
          { name: 'Contexto', value: `${contexto}${extra.sanctionId ? ` (ID ${extra.sanctionId})` : ''}` },
          { name: 'Motivo', value: String(error?.message || error) },
          { name: 'Sugerencia', value: 'El usuario puede tener los DMs cerrados o bloquear mensajes del servidor.' }
        )
        .setTimestamp(new Date());
      await logChannel.send({ embeds: [fail] });
    }
    return false;
  }
}

// ===== Helper visual: mencionar roles =====
function mentionRoles(ids) {
  if (!ids || ids.length === 0) return '—';
  return ids.map(id => `<@&${id}>`).join(', ');
}

// ===== Panel, Botones y Modales =====
const BTN_IDS = { SANCIONAR: 'sancionar_btn', ANULAR: 'anular_btn', BUSCAR: 'buscar_btn' };

function buildPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(BTN_IDS.SANCIONAR).setLabel('Sancionar').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(BTN_IDS.ANULAR).setLabel('Anular sanción').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(BTN_IDS.BUSCAR).setLabel('Buscar').setStyle(ButtonStyle.Primary)
    )
  ];
}

const MODAL_IDS = { SANCIONAR: 'modal_sancionar', ANULAR: 'modal_anular', BUSCAR: 'modal_buscar' };
const INPT = { USUARIO: 'usuario', TIPO: 'tipo', MOTIVO: 'motivo', AUTORIZA: 'autoriza', BUSCAR: 'usuario_buscar' };

function sancionarModal() {
  return new ModalBuilder()
    .setCustomId(MODAL_IDS.SANCIONAR)
    .setTitle('Sancionar usuario')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(INPT.USUARIO).setLabel('Usuario a sancionar (mención o ID)').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(INPT.TIPO).setLabel('Tipo (warn o strike)').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(INPT.MOTIVO).setLabel('Motivo de sanción').setStyle(TextInputStyle.Paragraph).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(INPT.AUTORIZA).setLabel('Autorizado por (mención o ID)').setStyle(TextInputStyle.Short).setRequired(true)
      )
    );
}
function anularModal() {
  return new ModalBuilder()
    .setCustomId(MODAL_IDS.ANULAR)
    .setTitle('Anular sanción')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(INPT.USUARIO).setLabel('Usuario (mención o ID)').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(INPT.TIPO).setLabel('Tipo a anular (warn o strike)').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(INPT.MOTIVO).setLabel('Motivo de anulación / apelación').setStyle(TextInputStyle.Paragraph).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(INPT.AUTORIZA).setLabel('Autorizado por (mención o ID)').setStyle(TextInputStyle.Short).setRequired(true)
      )
    );
}
function buscarModal() {
  return new ModalBuilder()
    .setCustomId(MODAL_IDS.BUSCAR)
    .setTitle('Buscar sanciones de usuario')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(INPT.BUSCAR)
          .setLabel('Usuario (mención o ID)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
}

// ===== Utils =====
async function resolveMember(guild, text) {
  const id = (text?.match(/\d{17,20}/) || [])[0];
  if (!id) return null;
  try { return await guild.members.fetch(id); } catch { return null; }
}
function normalizeType(t) {
  const s = String(t || '').trim().toLowerCase();
  if (['warn','warning','w'].includes(s)) return 'warn';
  if (['strike','s'].includes(s)) return 'strike';
  return null;
}

// (Defensa) anti duplicados por reintentos
const handled = new Set();
function markHandled(interaction) {
  if (handled.has(interaction.id)) return true;
  handled.add(interaction.id);
  setTimeout(() => handled.delete(interaction.id), 5 * 60 * 1000);
  return false;
}

// ===== Interactions =====
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (markHandled(interaction)) return;

    // ===== Slash commands =====
    if (interaction.isChatInputCommand()) {
      // PANEL + embed de ayuda + botones
      if (interaction.commandName === 'panel-sanciones') {
        const guild = interaction.guild;
        const logCh = guild.channels.cache.get(cfg.logChannelId);

        const embed = new EmbedBuilder()
          .setColor(cfg.panelEmbed?.color || cfg.embedColor || '#FFC0CB')
          .setTitle(cfg.panelEmbed?.title || 'Panel de sanciones • Ayuda rápida')
          .setDescription(
            'Usa los botones de abajo para gestionar sanciones.\n' +
            'Este panel muestra quién puede usar cada acción, los límites y dónde se registran los eventos.'
          )
          .addFields(
            {
              name: 'Botones',
              value:
                '• **Sancionar** → Abre formulario para aplicar `WARN` o `STRIKE`.\n' +
                '• **Anular sanción** → Abre formulario para anular la sancion de un usuario que apelo y fue aprobada.\n' +
                '• **Buscar** → Consulta sanciones activas de un usuario.'
            },
            {
              name: '**Consejitos**',
              value:
                `• Antes de usar un botón, saca el ID del usuario y del que autoriza.\n` +
                `• Escribe correctamente el motivo de la sanción; evita escribir todo en MAYÚSCULAS.\n` +
                `• Asegúrate de sancionar al usuario correcto`
        
            },
            {
              name: 'Límites',
              value: `Warns: **${MAX_WARN}** • Strikes: **${MAX_STRIKE}**`
            },
            {
              name: 'Notas',
              value:
                `• Se intenta enviar **DM** al usuario. Si falla, se loguea en ${logCh ? `${logCh}` : `#${cfg.logChannelId}`}.\n` +
                '• Puedes ver el resumen agrupado con **`/lista-sanciones`**.'
            }
          )
          .setFooter({ text: cfg.panelEmbed?.footer || cfg.listEmbed?.footer || 'Panel de Sanciones' })
          .setTimestamp(new Date());

        if (cfg.panelEmbed?.logoUrl || cfg.listEmbed?.logoUrl)
          embed.setThumbnail((cfg.panelEmbed?.logoUrl || cfg.listEmbed?.logoUrl));
        if (cfg.panelEmbed?.imageUrl || cfg.listEmbed?.imageUrl)
          embed.setImage((cfg.panelEmbed?.imageUrl || cfg.listEmbed?.imageUrl));

        await interaction.reply({
          embeds: [embed],
          components: buildPanelRows()
        });
        return;
      }

      // /lista-sanciones — público/ephemeral según config y AGRUPADO por usuario
      if (interaction.commandName === 'lista-sanciones') {
        const isPublic = cfg.listEmbed?.public ?? true;
        await interaction.deferReply(isPublic ? {} : { flags: 64 });

        const member = interaction.member;
        if (!hasAnyRole(member, cfg.listRoles)) {
          return interaction.editReply('⛔ No tienes permisos para ver la lista de sanciones.');
        }

        const db = loadDB();
        ensureGuild(db, interaction.guildId);
        const list = db.guilds[interaction.guildId].sanctions.filter(s => s.active);

        const makeEmbedBase = () => {
          const e = new EmbedBuilder().setColor(cfg.embedColor || '#FFC0CB');
          if (cfg.listEmbed?.logoUrl) e.setThumbnail(cfg.listEmbed.logoUrl);
          if (cfg.listEmbed?.imageUrl) e.setImage(cfg.listEmbed.imageUrl);
          if (cfg.listEmbed?.footer) e.setFooter({ text: cfg.listEmbed.footer });
          e.setTimestamp(new Date());
          return e;
        };

        // Agrupar por usuario (conteos)
        const grouped = new Map(); // userId -> { tag, warns, strikes }
        for (const s of list) {
          const g = grouped.get(s.userId) || { tag: s.userTag, warns: 0, strikes: 0 };
          if (s.type === 'warn') g.warns++;
          else if (s.type === 'strike') g.strikes++;
          grouped.set(s.userId, g);
        }

        const embed = makeEmbedBase()
          .setTitle(`${cfg.listEmbed?.title || '📋 Lista de sanciones activas'}: ${grouped.size} usuarios`)
          .addFields({ name: 'Totales', value: `Sanciones activas: ${list.length}` });

        if (grouped.size === 0) {
          embed.setDescription('✅ No hay sanciones activas.');
          await interaction.editReply({ embeds: [embed] });
          return;
        }

        const lines = [...grouped.entries()].map(([uid, g]) =>
          `• <@${uid}> — **Warns ${g.warns}/${MAX_WARN}** • **Strikes ${g.strikes}/${MAX_STRIKE}**`
        );

        // Evitar límite de descripción
        const MAX_LINES_IN_EMBED = 30;
        const shown = lines.slice(0, MAX_LINES_IN_EMBED);
        const hiddenUsers = Math.max(0, lines.length - shown.length);

        embed.setDescription(shown.join('\n'));
        if (hiddenUsers > 0) {
          embed.addFields({ name: '…', value: `y **${hiddenUsers}** usuarios más en el archivo adjunto.` });
        }

        // TXT completo (detalle por sanción)
        const txtLines = list.map(s => {
          const mention = `<@${s.userId}>`;
          return [
            `ID: ${s.id}`,
            `Usuario: ${s.userTag} (${mention})`,
            `Tipo: ${s.type.toUpperCase()}`,
            `Motivo: ${s.reason}`,
            `Autorizado por: ${s.authorizedByTag} (${s.authorizedById})`,
            `Sancionado por: ${s.issuedByTag} (${s.issuedById})`,
            `Fecha: ${s.createdAt}`
          ].join(' | ');
        });

        const fileName = `sanciones_${interaction.guildId}.txt`;
        try {
          fs.writeFileSync(fileName, txtLines.join('\n'), 'utf8');
          await interaction.editReply({ embeds: [embed], files: [fileName] });
        } finally {
          fs.unlink(fileName, () => {});
        }
        return;
      }

      return; // fin slash
    }

    // ===== Botones =====
    if (interaction.isButton()) {
      if (interaction.customId === BTN_IDS.SANCIONAR) {
        const member = interaction.member;
        if (!hasAnyRole(member, cfg.sanctionRoles)) {
          return interaction.reply({ flags: 64, content: '⛔ No tienes permisos para sancionar.' });
        }
        await interaction.showModal(sancionarModal());
        return;
      }

      if (interaction.customId === BTN_IDS.ANULAR) {
        const member = interaction.member;
        if (!hasAnyRole(member, cfg.annulRoles)) {
          return interaction.reply({ flags: 64, content: '⛔ No tienes permisos para anular sanciones.' });
        }
        await interaction.showModal(anularModal());
        return;
      }

      if (interaction.customId === BTN_IDS.BUSCAR) {
        const member = interaction.member;
        const permRoles = Array.from(new Set([...(cfg.sanctionRoles || []), ...(cfg.annulRoles || [])]));
        if (!hasAnyRole(member, permRoles)) {
          return interaction.reply({ flags: 64, content: '⛔ No tienes permisos para usar Buscar.' });
        }
        await interaction.showModal(buscarModal());
        return;
      }
    }

    // ===== Modales =====
    if (interaction.isModalSubmit()) {
      // ===== Modal: SANCIONAR =====
      if (interaction.customId === MODAL_IDS.SANCIONAR) {
        await interaction.deferReply({ flags: 64 });

        const guild = interaction.guild;
        const userText = interaction.fields.getTextInputValue(INPT.USUARIO);
        const typeText = interaction.fields.getTextInputValue(INPT.TIPO);
        const reason   = interaction.fields.getTextInputValue(INPT.MOTIVO);
        const authText = interaction.fields.getTextInputValue(INPT.AUTORIZA);

        const targetMember     = await resolveMember(guild, userText);
        const authorizedMember = await resolveMember(guild, authText);
        const type = normalizeType(typeText);

        if (!targetMember)     return interaction.editReply('❌ Usuario a sancionar inválido.');
        if (!authorizedMember) return interaction.editReply('❌ Usuario que autoriza inválido.');
        if (!type)             return interaction.editReply('❌ Tipo inválido. Usa "warn" o "strike".');

        const db = loadDB();
        ensureGuild(db, guild.id);
        const sanctionId = `${Date.now()}_${Math.floor(Math.random()*9999)}`;

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
          active: true
        };

        // Guardar SIEMPRE (aunque falle el DM)
        db.guilds[guild.id].sanctions.push(record);
        saveDB(db);

        const { warns, strikes } = countActiveSanctions(db, guild.id, targetMember.id);

        // DM con log de fallo (incluye sanctionId)
        {
          const dm = buildDmSanctionEmbed({
            type,
            guildName: guild.name,
            reason,
            authorizedBy: authorizedMember.user.tag,
            warns,
            strikes
          });
          await sendDmAndLog(guild, targetMember.user, dm, 'Notificación de sanción', { sanctionId });
        }

        // Log de la acción
        try {
          const channel = guild.channels.cache.get(cfg.logChannelId);
          if (channel) {
            const e = logEmbed({
              title: '📌 Nueva sanción',
              actor: interaction.user,
              target: targetMember.user,
              type,
              reason,
              authorizedBy: authorizedMember.user.tag,
              sanctionId
            });
            e.addFields({ name: 'Acumulado', value: `Warns ${warns}/${MAX_WARN} • Strikes ${strikes}/${MAX_STRIKE}` });
            await channel.send({ embeds: [e] });
          }
        } catch {}

        return interaction.editReply(
          `✅ ${type.toUpperCase()} a **${targetMember.user.tag}** · Warns ${warns}/${MAX_WARN} · Strikes ${strikes}/${MAX_STRIKE} (ID ${sanctionId}).`
        );
      }

      // ===== Modal: ANULAR =====
      if (interaction.customId === MODAL_IDS.ANULAR) {
        await interaction.deferReply({ flags: 64 });

        const guild = interaction.guild;
        const userText = interaction.fields.getTextInputValue(INPT.USUARIO);
        const typeText = interaction.fields.getTextInputValue(INPT.TIPO);
        const reason   = interaction.fields.getTextInputValue(INPT.MOTIVO);
        const authText = interaction.fields.getTextInputValue(INPT.AUTORIZA);

        const targetMember     = await resolveMember(guild, userText);
        const authorizedMember = await resolveMember(guild, authText);
        const type = normalizeType(typeText);

        if (!targetMember)     return interaction.editReply('❌ Usuario inválido.');
        if (!authorizedMember) return interaction.editReply('❌ Usuario que autoriza inválido.');
        if (!type)             return interaction.editReply('❌ Tipo inválido. Usa "warn" o "strike".');

        const db = loadDB();
        ensureGuild(db, guild.id);
        const list = db.guilds[guild.id].sanctions;

        // última sanción activa de ese tipo
        const idx = [...list].reverse().findIndex(s => s.active && s.userId === targetMember.id && s.type === type);
        if (idx === -1) {
          return interaction.editReply('ℹ️ No se encontró una sanción activa de ese tipo para ese usuario.');
        }
        const realIndex = list.length - 1 - idx;
        const sanction  = list[realIndex];

        sanction.active = false;
        sanction.annul = {
          reason,
          authorizedById: authorizedMember.id,
          authorizedByTag: authorizedMember.user.tag,
          annulledById: interaction.user.id,
          annulledByTag: interaction.user.tag,
          annulledAt: nowISO()
        };
        saveDB(db);

        const { warns, strikes } = countActiveSanctions(db, guild.id, targetMember.id);

        // DM con log de fallo
        {
          const dm = buildDmAnnulEmbed({
            type,
            guildName: guild.name,
            reason,
            authorizedBy: authorizedMember.user.tag,
            warns,
            strikes
          });
          await sendDmAndLog(guild, targetMember.user, dm, 'Notificación de anulación', { sanctionId: sanction.id });
        }

        // Log de la acción
        try {
          const channel = guild.channels.cache.get(cfg.logChannelId);
          if (channel) {
            const e = annulLogEmbed({
              title: '♻️ Sanción anulada',
              actor: interaction.user,
              target: targetMember.user,
              type,
              reason,
              authorizedBy: authorizedMember.user.tag,
              sanctionId: sanction.id
            });
            e.addFields({ name: 'Acumulado', value: `Warns ${warns}/${MAX_WARN} • Strikes ${strikes}/${MAX_STRIKE}` });
            await channel.send({ embeds: [e] });
          }
        } catch {}

        return interaction.editReply(
          `✅ Sanción **${type.toUpperCase()}** anulada a **${targetMember.user.tag}** · Warns ${warns}/${MAX_WARN} · Strikes ${strikes}/${MAX_STRIKE}.`
        );
      }

      // ===== Modal: BUSCAR =====
      if (interaction.customId === MODAL_IDS.BUSCAR) {
        await interaction.deferReply({ flags: 64 });

        const guild = interaction.guild;
        const query = interaction.fields.getTextInputValue(INPT.BUSCAR);

        const targetMember = await resolveMember(guild, query);
        if (!targetMember) {
          return interaction.editReply('❌ Usuario inválido. Menciona o pega un ID válido.');
        }

        const db = loadDB();
        ensureGuild(db, guild.id);

        const { warns, strikes } = countActiveSanctions(db, guild.id, targetMember.id);
        const active = (db.guilds[guild.id]?.sanctions || [])
          .filter(s => s.active && s.userId === targetMember.id)
          .slice(-5)
          .reverse();

        const e = new EmbedBuilder()
          .setColor(cfg.embedColor || '#FFC0CB')
          .setTitle('🔎 Resultado de búsqueda')
          .setDescription(`${targetMember} — **${targetMember.user.tag}**`)
          .addFields(
            { name: 'Warns', value: `${warns}/${MAX_WARN}`, inline: true },
            { name: 'Strikes', value: `${strikes}/${MAX_STRIKE}`, inline: true }
          )
          .setTimestamp(new Date());

        if (active.length > 0) {
          e.addFields({
            name: 'Sanciones activas',
            value: active.map(s => `• **${s.type.toUpperCase()}** — ${s.reason} (ID \`${s.id}\`)`).join('\n')
          });
        } else {
          e.addFields({ name: 'Sanciones activas', value: '—' });
        }

        if (cfg.listEmbed?.logoUrl) e.setThumbnail(cfg.listEmbed.logoUrl);
        if (cfg.listEmbed?.imageUrl) e.setImage(cfg.listEmbed.imageUrl);
        if (cfg.listEmbed?.footer) e.setFooter({ text: cfg.listEmbed.footer });

        return interaction.editReply({ embeds: [e] });
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      interaction.reply({ flags: 64, content: '⚠️ Ocurrió un error inesperado.' }).catch(()=>{});
    }
  }
});

client.login(process.env.TOKEN);
