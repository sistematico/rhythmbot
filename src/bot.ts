import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  Message,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type Interaction,
  type TextChannel,
} from 'discord.js';
import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import { config } from 'dotenv';

const require = createRequire(import.meta.url);
const dfi = require('d-fi-core');
const { getSongFileName } = require('d-fi-core/dist/deezer/lib/decrypt');

config();

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DEEZER_ARL = process.env.DEEZER_ARL;

if (!TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN e CLIENT_ID precisam estar definidos no .env');
  process.exit(1);
}

if (!DEEZER_ARL) {
  console.error('DEEZER_ARL precisa estar definido no .env');
  process.exit(1);
}

// ─── Slash commands ───────────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Toca uma música do Deezer no canal de voz')
    .addStringOption(option =>
      option
        .setName('query')
        .setDescription('URL do Deezer ou termo de busca')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Exibe botões para tocar rádios shoutcast/icecast predefinidas'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Para a reprodução e desconecta do canal de voz'),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Pula a música atual da fila'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Exibe a fila de reprodução atual'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove uma música da fila pelo número')
    .addIntegerOption(option =>
      option
        .setName('posicao')
        .setDescription('Número da música na fila (use /queue para ver)')
        .setMinValue(1)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('rm')
    .setDescription('Atalho para remover uma música da fila pelo número')
    .addIntegerOption(option =>
      option
        .setName('posicao')
        .setDescription('Número da música na fila (use /queue para ver)')
        .setMinValue(1)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Ajusta o volume da reprodução (0–100)')
    .addIntegerOption(option =>
      option
        .setName('nivel')
        .setDescription('Nível de volume entre 0 e 100')
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('random')
    .setDescription('Sugere uma música baseada na playlist atual e permite adicionar ou descartar'),
] as const;

// ─── Radio stations ───────────────────────────────────────────────────────────

interface RadioStation {
  id: string;
  name: string;
  emoji: string;
  url: string;
}

const RADIO_STATIONS: RadioStation[] = [
  { id: 'sdm',      name: 'Som do Mato',    emoji: '🌎', url: 'https://radio.somdomato.com/geral' },
  { id: 'rtm',      name: 'Rhythm Place',    emoji: '🌎', url: 'https://stream.rhythm.place/stream' },
  { id: 'jovempan',       name: 'Jovem Pan',      emoji: '📻', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/JOVEMPANFM.mp3' },
  { id: 'antena1',        name: 'Antena 1',       emoji: '🎵', url: 'https://antenaone.crossradio.com.br/stream/1' },
  { id: 'cbn',            name: 'CBN',            emoji: '🗣️', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/CBNAM.mp3' },
  { id: 'metropolitana',  name: 'Metropolitana',  emoji: '🏙️', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/METROPOLITANAFM.mp3' },
  { id: 'transamerica',   name: 'Transamérica',   emoji: '🌎', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/TRANSAMFM.mp3' },
  { id: 'bandnews',       name: 'BandNews',       emoji: '📰', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/BANDNEWSFM.mp3' },
  { id: 'mix',            name: 'Mix FM',         emoji: '🎶', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/MIXFM.mp3' },
  { id: 'cultura',        name: 'Rádio Cultura',  emoji: '🎼', url: 'https://streaming.rts.com.br/radiocultura' },
  { id: 'alpha',          name: 'Alpha FM',       emoji: '✨', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/ALPHAFM.mp3' },
];

// ─── Deezer helpers ──────────────────────────────────────────────────────────

const DEEZER_TRACK_RE = /deezer\.com\/(?:\w+\/)?track\/(\d+)/;

interface DfiTrack {
  SNG_ID: string;
  SNG_TITLE: string;
  ART_NAME: string;
  VERSION?: string;
  MD5_ORIGIN?: string;
  MEDIA_VERSION?: string;
  TRACK_TOKEN?: string;
}

interface DfiSearchTrack {
  SNG_ID?: string;
}

interface RandomSuggestion {
  track: DfiTrack;
  basedOn: DfiTrack;
}

interface DeezerMediaUserData {
  licenseToken: string;
  canStreamLossless: boolean;
  canStreamHq: boolean;
  country: string;
}

let deezerMediaUserData: DeezerMediaUserData | null = null;

function getDeezerMediaFormat(quality: 1 | 3 | 9): 'MP3_128' | 'MP3_320' | 'FLAC' {
  switch (quality) {
    case 9:
      return 'FLAC';
    case 3:
      return 'MP3_320';
    case 1:
      return 'MP3_128';
  }
}

async function fetchDeezerMediaUserData(): Promise<DeezerMediaUserData> {
  if (deezerMediaUserData) {
    return deezerMediaUserData;
  }

  const response = await fetch(
    'https://www.deezer.com/ajax/gw-light.php?method=deezer.getUserData&api_version=1.0&api_token=null',
    {
      headers: {
        Accept: '*/*',
        Cookie: `arl=${DEEZER_ARL}`,
        'User-Agent': 'Deezer/8.32.0.2 (iOS; 14.4; Mobile; en; iPhone10_5)',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Erro ao autenticar na API de mídia do Deezer: HTTP ${response.status}`);
  }

  const data = await response.json() as {
    results?: {
      COUNTRY?: string;
      USER?: {
        OPTIONS?: {
          license_token?: string;
          web_lossless?: boolean;
          mobile_loseless?: boolean;
          web_hq?: boolean;
          mobile_hq?: boolean;
        };
      };
    };
  };

  const options = data.results?.USER?.OPTIONS;
  const licenseToken = options?.license_token;
  if (!licenseToken) {
    throw new Error('Não foi possível obter a licença de mídia do Deezer.');
  }

  deezerMediaUserData = {
    licenseToken,
    canStreamLossless: Boolean(options.web_lossless || options.mobile_loseless),
    canStreamHq: Boolean(options.web_hq || options.mobile_hq),
    country: data.results?.COUNTRY ?? 'desconhecido',
  };

  return deezerMediaUserData;
}

async function probeDownloadUrl(url: string): Promise<number> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: {
        Accept: '*/*',
        'User-Agent': 'Mozilla/5.0',
      },
    });

    if (!response.ok) {
      return 0;
    }

    return Number(response.headers.get('content-length') ?? '0');
  } catch {
    return 0;
  }
}

function buildLegacyDeezerDownloadUrl(track: DfiTrack, quality: 1 | 3 | 9): string | null {
  if (!track.MD5_ORIGIN || !track.SNG_ID || !track.MEDIA_VERSION) {
    return null;
  }

  const filename = getSongFileName(track, quality);
  return `https://e-cdns-proxy-${track.MD5_ORIGIN[0]}.dzcdn.net/mobile/1/${filename}`;
}

async function getOfficialTrackDownloadUrl(track: DfiTrack, quality: 1 | 3 | 9): Promise<string | null> {
  if (!track.TRACK_TOKEN) {
    return null;
  }

  const user = await fetchDeezerMediaUserData();
  const format = getDeezerMediaFormat(quality);

  if ((format === 'FLAC' && !user.canStreamLossless) || (format === 'MP3_320' && !user.canStreamHq)) {
    return null;
  }

  const response = await fetch('https://media.deezer.com/v1/get_url', {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': 'Deezer/8.32.0.2 (iOS; 14.4; Mobile; en; iPhone10_5)',
    },
    body: JSON.stringify({
      license_token: user.licenseToken,
      media: [
        {
          type: 'FULL',
          formats: [{ format, cipher: 'BF_CBC_STRIPE' }],
        },
      ],
      track_tokens: [track.TRACK_TOKEN],
    }),
  });

  if (!response.ok) {
    throw new Error(`Erro ao consultar mídia do Deezer: HTTP ${response.status}`);
  }

  const data = await response.json() as {
    data?: Array<{
      errors?: Array<Record<string, unknown>>;
      media?: Array<{
        sources?: Array<{
          url?: string;
        }>;
      }>;
    }>;
  };

  const firstItem = Array.isArray(data.data) ? data.data[0] : undefined;
  if (!firstItem) {
    return null;
  }

  const firstError = Array.isArray(firstItem.errors) ? firstItem.errors[0] : undefined;
  if (firstError) {
    console.warn(
      `[deezer] Mídia oficial indisponível (${
        Object.entries(firstError).map(([key, value]) => `${key}: ${String(value)}`).join(', ')
      }), tentando URL legado.`,
    );
    return null;
  }

  const sourceUrl = firstItem.media?.[0]?.sources?.[0]?.url;
  return typeof sourceUrl === 'string' && sourceUrl.length > 0 ? sourceUrl : null;
}

async function getTrackDownloadInfo(track: DfiTrack, quality: 1 | 3 | 9): Promise<{ trackUrl: string; isEncrypted: boolean } | null> {
  const officialUrl = await getOfficialTrackDownloadUrl(track, quality);
  if (officialUrl && await probeDownloadUrl(officialUrl) > 0) {
    return {
      trackUrl: officialUrl,
      isEncrypted: officialUrl.includes('/mobile/') || officialUrl.includes('/media/'),
    };
  }

  const legacyUrl = buildLegacyDeezerDownloadUrl(track, quality);
  if (legacyUrl && await probeDownloadUrl(legacyUrl) > 0) {
    return {
      trackUrl: legacyUrl,
      isEncrypted: legacyUrl.includes('/mobile/') || legacyUrl.includes('/media/'),
    };
  }

  return null;
}

async function fetchTrack(query: string): Promise<{ type: 'deezer'; track: DfiTrack }> {
  // Deezer URL
  const deezerMatch = query.match(DEEZER_TRACK_RE);
  if (deezerMatch) {
    const track = await dfi.getTrackInfo(deezerMatch[1]);
    if (!track?.SNG_ID) {
      throw new Error('Faixa não encontrada no Deezer.');
    }
    return { type: 'deezer', track };
  }

  // Busca no Deezer
  const results = await dfi.searchMusic(query, ['TRACK'], 1);
  const tracks = results?.TRACK?.data as DfiSearchTrack[] | undefined;
  const firstTrackId = tracks?.[0]?.SNG_ID;
  if (firstTrackId) {
    const fullTrack = await dfi.getTrackInfo(firstTrackId);
    if (!fullTrack?.SNG_ID) {
      throw new Error('Não foi possível carregar os dados completos da faixa.');
    }
    return { type: 'deezer', track: fullTrack };
  }

  throw new Error('Nenhum resultado encontrado no Deezer.');
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

async function downloadTrack(track: DfiTrack): Promise<Buffer> {
  // Try preferred qualities first and gracefully fallback on 403/availability issues.
  const preferredQualities = [3, 1, 9] as const;
  let lastError: Error | null = null;

  for (const quality of preferredQualities) {
    try {
      const dlInfo = await getTrackDownloadInfo(track, quality);
      if (!dlInfo) {
        continue;
      }

      const raw = await downloadBinary(dlInfo.trackUrl);
      return dlInfo.isEncrypted ? dfi.decryptDownload(raw, track.SNG_ID) : raw;
    } catch (error) {
      if (error instanceof Error && error.message.includes('403')) {
        lastError = error;
        continue;
      }

      if (error instanceof Error) {
        lastError = error;
        continue;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Faixa indisponível para download.');
}

function trackDisplayName(track: DfiTrack): string {
  const version = track.VERSION ? ` (${track.VERSION})` : '';
  return `${track.ART_NAME} - ${track.SNG_TITLE}${version}`;
}

function normalizePlaybackError(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error ?? 'Erro desconhecido.');
  const lowered = rawMessage.toLowerCase();

  if (lowered.includes('valid_token_required') || lowered.includes('invalid csrf token')) {
    return 'Sua sessão Deezer expirou (DEEZER_ARL inválido). Atualize o DEEZER_ARL no .env e reinicie o bot.';
  }

  return rawMessage;
}

function buildPlaylistSeedTracks(): DfiTrack[] {
  const seeds: DfiTrack[] = [];
  if (currentItem?.resolved.type === 'deezer') {
    seeds.push(currentItem.resolved.track);
  }

  for (const item of queue) {
    if (item.resolved.type === 'deezer') {
      seeds.push(item.resolved.track);
    }
  }

  return seeds;
}

function buildRandomSuggestionRow(ownerId: string, trackId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`random_add_${ownerId}_${trackId}`)
      .setLabel('Adicionar na playlist')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`random_discard_${ownerId}_${trackId}`)
      .setLabel('Descartar')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildRandomSuggestionMessage(ownerId: string, suggestion: RandomSuggestion): {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  return {
    content: [
      '🎲 Sugestão baseada na sua playlist:',
      `**${trackDisplayName(suggestion.track)}**`,
      `Inspirada em: **${trackDisplayName(suggestion.basedOn)}**`,
      `https://www.deezer.com/track/${suggestion.track.SNG_ID}`,
    ].join('\n'),
    components: [buildRandomSuggestionRow(ownerId, suggestion.track.SNG_ID)],
  };
}

async function suggestTrackFromPlaylist(excludedIds: Set<string>): Promise<RandomSuggestion> {
  const seeds = buildPlaylistSeedTracks();
  if (seeds.length === 0) {
    throw new Error('A playlist está vazia. Toque ou enfileire músicas antes de usar /random.');
  }

  const sourceTrackIds = new Set<string>(seeds.map(seed => seed.SNG_ID));
  const shuffledSeeds = [...seeds].sort(() => Math.random() - 0.5);

  for (const seed of shuffledSeeds) {
    const results = await dfi.searchMusic(seed.ART_NAME, ['TRACK'], 30);
    const tracks = results?.TRACK?.data as DfiSearchTrack[] | undefined;
    const candidateIds = (tracks ?? [])
      .map(track => track.SNG_ID)
      .filter((id): id is string => !!id && !excludedIds.has(id) && !sourceTrackIds.has(id));

    if (candidateIds.length === 0) {
      continue;
    }

    const selectedId = pickRandom(candidateIds);
    const fullTrack = await dfi.getTrackInfo(selectedId);
    if (!fullTrack?.SNG_ID || excludedIds.has(fullTrack.SNG_ID) || sourceTrackIds.has(fullTrack.SNG_ID)) {
      continue;
    }

    return { track: fullTrack, basedOn: seed };
  }

  throw new Error('Não encontrei novas sugestões no Deezer com base na sua playlist agora.');
}

// ─── Radio stream helper ──────────────────────────────────────────────────────

function fetchRadioStream(url: string, redirects = 5): Promise<Readable> {
  return new Promise((resolve, reject) => {
    if (redirects === 0) {
      reject(new Error('Muitos redirecionamentos ao conectar à rádio.'));
      return;
    }
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Icy-MetaData': '0' } }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(fetchRadioStream(res.headers.location, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} ao conectar à rádio.`));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

function downloadBinary(url: string, redirects = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (redirects === 0) {
      reject(new Error('Muitos redirecionamentos ao baixar faixa.'));
      return;
    }

    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: '*/*',
        },
      },
      res => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          resolve(downloadBinary(nextUrl, redirects - 1));
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Erro ao baixar faixa: ${res.statusCode ?? 'desconhecido'}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );

    req.on('error', reject);
  });
}

async function createStableAudioResource(stream: Readable) {
  try {
    const probed = await Promise.race([
      demuxProbe(stream),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Probe timeout')), 2500);
      }),
    ]);
    return createAudioResource(probed.stream, {
      inputType: probed.type,
      inlineVolume: true,
    });
  } catch {
    return createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
  }
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// ─── Volume & queue state ─────────────────────────────────────────────────────

let currentVolume = 0.2; // 20% por padrão

interface QueueItem {
  title: string;
  addedBy: string;     // userId
  addedByTag: string;  // username para display
  resolved: { type: 'deezer'; track: DfiTrack };
}

let queue: QueueItem[] = [];
let currentItem: QueueItem | null = null;
let radioState: { stationName: string; emoji: string; startedBy: string } | null = null;
let activeGuildId: string | null = null;
//let activeVoiceChannelId: string | null = null;
let activeTextChannelId: string | null = null;
type RepeatMode = 'off' | 'all' | 'one';
let repeatMode: RepeatMode = 'off';

let isProcessingQueue = false;
let playbackGeneration = 0;
let queueMessageId: string | null = null;
let volumeMessageId: string | null = null;
const randomSuggestionExclusionsByMessage = new Map<string, Set<string>>();

// ─── Permission helper ────────────────────────────────────────────────────────

function isAdmin(member: GuildMember): boolean {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

function buildQueueMessage(): string | null {
  if (!currentItem && queue.length === 0) {
    return null;
  }

  const items: string[] = [];

  if (currentItem) {
    items.push(`1 - Tocando agora: ${currentItem.title} | por ${currentItem.addedByTag}`);
  }

  queue.forEach((item, i) => {
    const index = currentItem ? i + 2 : i + 1;
    items.push(`${index} - ${item.title} | por ${item.addedByTag}`);
  });

  return ['🎶 Fila de reproducao', '```md', ...items, '```'].join('\n');
}

async function deleteQueueMessage(): Promise<void> {
  if (!activeGuildId || !activeTextChannelId || !queueMessageId) {
    queueMessageId = null;
    return;
  }

  try {
    const guild = await client.guilds.fetch(activeGuildId);
    const channel = await guild.channels.fetch(activeTextChannelId) as TextChannel | null;
    const msg = await channel?.messages.fetch(queueMessageId);
    await msg?.delete();
  } catch {
    // pode já ter sido apagada manualmente
  } finally {
    queueMessageId = null;
  }
}

function buildRepeatRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('repeat_all')
      .setLabel('🔁 Repetir fila')
      .setStyle(repeatMode === 'all' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('repeat_one')
      .setLabel('🔂 Repetir faixa')
      .setStyle(repeatMode === 'one' ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
}

async function syncQueueMessage(): Promise<void> {
  const content = buildQueueMessage();
  if (!content) {
    await deleteQueueMessage();
    return;
  }

  if (!activeGuildId || !activeTextChannelId) {
    return;
  }

  try {
    const guild = await client.guilds.fetch(activeGuildId);
    const channel = await guild.channels.fetch(activeTextChannelId) as TextChannel | null;
    if (!channel) return;

    if (queueMessageId) {
      try {
        const existing = await channel.messages.fetch(queueMessageId);
        await existing.edit({ content, components: [buildRepeatRow()] });
        return;
      } catch {
        queueMessageId = null;
      }
    }

    const sent = await channel.send({ content, components: [buildRepeatRow()] });
    queueMessageId = sent.id;
  } catch {
    // falha silenciosa para não interromper fluxo de áudio
  }
}

// ─── Audio player ─────────────────────────────────────────────────────────────

const player = createAudioPlayer();

player.on('error', error => {
  console.error('Erro no player de áudio:', error.message);

  // Evita deadlock da fila quando a faixa falha antes de entrar em Playing.
  isProcessingQueue = false;
  currentItem = null;

  if (radioState === null && queue.length > 0) {
    playNextInQueue().catch(err => console.error('[player.error] erro ao avançar fila:', err));
  } else {
    syncQueueMessage().catch(err => console.error('[player.error] erro ao sincronizar fila:', err));
  }
});

// ─── Playlist state management ────────────────────────────────────────────────

function clearPlayerState(): void {
  playbackGeneration++; // invalidate any in-flight downloads
  queue = [];
  currentItem = null;
  radioState = null;
  repeatMode = 'off';
  activeGuildId = null;
  //activeVoiceChannelId = null;
  activeTextChannelId = null;
  queueMessageId = null;
  volumeMessageId = null;
  randomSuggestionExclusionsByMessage.clear();
  isProcessingQueue = false;
}

async function playNextInQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  const generation = playbackGeneration;

  // Handle repeat modes using the track that just finished
  if (currentItem) {
    if (repeatMode === 'one') {
      queue.unshift(currentItem);
    } else if (repeatMode === 'all') {
      queue.push(currentItem);
    }
  }

  if (queue.length === 0) {
    isProcessingQueue = false;
    currentItem = null;
    await deleteQueueMessage();
    if (activeGuildId) {
      const conn = getVoiceConnection(activeGuildId);
      conn?.destroy();
    }
    clearPlayerState();
    return;
  }

  const item = queue.shift();
  if (!item) {
    isProcessingQueue = false;
    currentItem = null;
    await syncQueueMessage();
    return;
  }
  currentItem = item;
  await syncQueueMessage();

  try {
    const audioBuffer = await downloadTrack(item.resolved.track);

    // If a skip/stop happened while downloading, abandon this stale download.
    if (generation !== playbackGeneration) {
      isProcessingQueue = false;
      return;
    }

    const stream = Readable.from([audioBuffer]);
    const resource = await createStableAudioResource(stream);

    if (generation !== playbackGeneration) {
      isProcessingQueue = false;
      return;
    }

    resource.volume?.setVolume(currentVolume);

    player.play(resource);
    // isProcessingQueue só é liberado quando o player entrar em Playing (via stateChange)

    // A mensagem fixa da fila ja indica a musica atual para evitar duplicidade no chat.
  } catch (error) {
    console.error('[playNextInQueue] erro ao carregar faixa:', error);
    currentItem = null;
    isProcessingQueue = false;

    // Anuncia erro e tenta próxima (se houver)
    if (activeTextChannelId && activeGuildId) {
      try {
        const guild = await client.guilds.fetch(activeGuildId);
        const channel = await guild.channels.fetch(activeTextChannelId) as TextChannel | null;
        const msg = error instanceof Error ? error.message : 'Erro desconhecido.';
        await channel?.send(`⚠️ Não foi possível reproduzir **${item.title}**: ${msg}`);
      } catch { /* silencioso */ }
    }

    if (queue.length > 0) {
      playNextInQueue().catch(err => console.error('[playNextInQueue] erro na faixa seguinte:', err));
    } else {
      syncQueueMessage().catch(err => console.error('[playNextInQueue] erro ao sincronizar fila:', err));
    }
    // Não destrói a conexão em caso de erro — aguarda próximo /play ou /stop
  }
}

// Avança fila automaticamente ao terminar
player.on('stateChange', (oldState, newState) => {
  // Libera o lock assim que o player começa a tocar de verdade
  if (newState.status === AudioPlayerStatus.Playing) {
    isProcessingQueue = false;
  }

  // Também libera lock ao voltar para Idle para não travar em falhas de decode/probe.
  if (newState.status === AudioPlayerStatus.Idle) {
    isProcessingQueue = false;
  }

  // Avança a fila quando uma faixa termina (ou falha após ter iniciado)
  if (
    !isProcessingQueue &&
    oldState.status !== AudioPlayerStatus.Idle &&
    newState.status === AudioPlayerStatus.Idle &&
    radioState === null
  ) {
    playNextInQueue().catch(err => console.error('[stateChange] erro:', err));
  }
});

client.once(Events.ClientReady, async readyClient => {
  console.log(`Pronto! Logado como ${readyClient.user.tag}`);

  try {
    await dfi.initDeezerApi(DEEZER_ARL);
    console.log('Deezer API inicializada.');
  } catch (error) {
    const msg = normalizePlaybackError(error);
    console.error(`Falha ao inicializar Deezer API: ${msg}`);
    process.exit(1);
  }

  const rest = new REST().setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), {
    body: commands.map(c => c.toJSON()),
  });
  console.log('Slash commands registrados.');
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  try {
  // ── /radio (botões) ────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('radio_')) {
    const stationId = interaction.customId.slice('radio_'.length);
    const station = RADIO_STATIONS.find(s => s.id === stationId);
    if (!station) {
      await interaction.reply({ content: 'Rádio não encontrada.', ephemeral: true });
      return;
    }

    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: 'Você precisa estar em um canal de voz para usar este botão.',
        ephemeral: true,
      });
      return;
    }

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: 'Este botão só pode ser usado dentro de um servidor.',
        ephemeral: true,
      });
      return;
    }

    // Bloqueia rádio se há playlist ativa e o usuário não é admin
    if ((currentItem !== null || queue.length > 0) && !isAdmin(member)) {
      await interaction.reply({
        content: 'O bot está no modo playlist. Apenas administradores podem iniciar uma rádio agora.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    // Remove o painel de botões após o clique para evitar interações antigas.
    const radioMenuMessage = interaction.message;
    if (radioMenuMessage instanceof Message && radioMenuMessage.author.id === client.user?.id) {
      radioMenuMessage.delete().catch(() => undefined);
    }

    // Admin interrompendo playlist ativa: limpa estado antes de iniciar a rádio
    if (currentItem !== null || queue.length > 0) {
      player.stop(true);
      await deleteQueueMessage();
      if (activeGuildId) {
        const conn = getVoiceConnection(activeGuildId);
        conn?.destroy();
      }
      clearPlayerState();
    }

    try {
      const stream = await fetchRadioStream(station.url);
      const resource = await createStableAudioResource(stream);
      resource.volume?.setVolume(currentVolume);

      let connection = getVoiceConnection(guildId);
      if (!connection) {
        connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });
        try {
          await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        } catch {
          connection.destroy();
          await interaction.editReply('Não foi possível conectar ao canal de voz.');
          return;
        }
      }

      radioState = { stationName: station.name, emoji: station.emoji, startedBy: interaction.user.id };
      activeGuildId = guildId;

      player.play(resource);
      connection.subscribe(player);

      await interaction.editReply(`${station.emoji} Tocando **${station.name}** ao vivo!`);
    } catch (error) {
      console.error('Erro ao tocar rádio:', error);
      const msg = error instanceof Error ? error.message : 'Erro desconhecido.';
      await interaction.editReply(`Não foi possível tocar a rádio: ${msg}`);
    }

    return;
  }

  // ── /random (botões) ──────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('random_')) {
    const [prefix, action, ownerId, trackId] = interaction.customId.split('_');
    if (prefix !== 'random' || !action || !ownerId || !trackId) {
      await interaction.reply({ content: 'Interação inválida para sugestão aleatória.', ephemeral: true });
      return;
    }

    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: 'Apenas quem pediu a sugestão pode usar esses botões.', ephemeral: true });
      return;
    }

    const messageId = interaction.message.id;
    const excludedIds = randomSuggestionExclusionsByMessage.get(messageId) ?? new Set<string>();
    excludedIds.add(trackId);
    randomSuggestionExclusionsByMessage.set(messageId, excludedIds);

    if (action === 'discard') {
      await interaction.deferUpdate();
      try {
        const suggestion = await suggestTrackFromPlaylist(excludedIds);
        await interaction.message.edit(buildRandomSuggestionMessage(ownerId, suggestion));
      } catch (error) {
        const msg = normalizePlaybackError(error);
        await interaction.followUp({ content: `Não foi possível gerar outra sugestão: ${msg}`, ephemeral: true });
      }
      return;
    }

    if (action === 'add') {
      if (radioState !== null) {
        await interaction.reply({
          content: 'Não é possível adicionar sugestão na playlist enquanto uma rádio está tocando.',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferUpdate();

      try {
        const track = await dfi.getTrackInfo(trackId);
        if (!track?.SNG_ID) {
          throw new Error('Faixa sugerida não encontrada no Deezer.');
        }

        const item: QueueItem = {
          title: trackDisplayName(track),
          addedBy: interaction.user.id,
          addedByTag: interaction.user.tag ?? interaction.user.username,
          resolved: { type: 'deezer', track },
        };

        queue.push(item);

        if (interaction.guildId) {
          activeGuildId = interaction.guildId;
          activeTextChannelId = interaction.channelId;
        }

        await interaction.message.edit({
          content: `✅ **${item.title}** adicionada à playlist.`,
          components: [],
        });

        randomSuggestionExclusionsByMessage.delete(messageId);
        await syncQueueMessage();

        if (player.state.status === AudioPlayerStatus.Idle && !isProcessingQueue) {
          playNextInQueue().catch(err => console.error('[random.add] erro em playNextInQueue:', err));
        }
      } catch (error) {
        const msg = normalizePlaybackError(error);
        await interaction.followUp({ content: `Não foi possível adicionar a sugestão: ${msg}`, ephemeral: true });
      }

      return;
    }

    await interaction.reply({ content: 'Ação de sugestão desconhecida.', ephemeral: true });
    return;
  }

  // ── Repeat buttons ─────────────────────────────────────────────────────────
  if (interaction.isButton() && (interaction.customId === 'repeat_all' || interaction.customId === 'repeat_one')) {
    if (radioState !== null) {
      await interaction.reply({ content: 'Repetição não está disponível no modo rádio.', ephemeral: true });
      return;
    }

    const mode: RepeatMode = interaction.customId === 'repeat_all' ? 'all' : 'one';
    repeatMode = repeatMode === mode ? 'off' : mode;

    const labels: Record<RepeatMode, string> = { off: 'desligado', all: 'repetindo fila', one: 'repetindo faixa' };
    await interaction.reply({ content: `🔁 Modo de repetição: **${labels[repeatMode]}**`, ephemeral: true });
    await syncQueueMessage();
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (!interaction.guildId) {
    await interaction.reply({ content: 'Este comando só pode ser usado dentro de um servidor.', ephemeral: true });
    return;
  }

  const { commandName } = interaction;

  // ── /radio ─────────────────────────────────────────────────────────────────
  if (commandName === 'radio') {
    // Divide as estações em linhas de até 5 botões
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < RADIO_STATIONS.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        RADIO_STATIONS.slice(i, i + 5).map(s =>
          new ButtonBuilder()
            .setCustomId(`radio_${s.id}`)
            .setLabel(s.name)
            .setEmoji(s.emoji)
            .setStyle(ButtonStyle.Secondary),
        ),
      );
      rows.push(row);
    }

    await interaction.reply({
      content: '📻 Escolha uma rádio para tocar no seu canal de voz:',
      components: rows,
    });
    return;
  }

  // ── /play ──────────────────────────────────────────────────────────────────
  if (commandName === 'play') {
    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: 'Você precisa estar em um canal de voz para usar este comando.',
        ephemeral: true,
      });
      return;
    }

    // Bloqueia /play durante rádio para não-admins
    if (radioState !== null && !isAdmin(member)) {
      await interaction.reply({
        content: `O bot está tocando a rádio **${radioState.stationName}** ao vivo. Apenas administradores podem interromper.`,
        ephemeral: true,
      });
      return;
    }

    const query = interaction.options.getString('query', true);
    await interaction.deferReply();

    try {
      // Resolve título e fonte agora; o download/stream ocorre em playNextInQueue
      const resolved = await fetchTrack(query);
      const title = trackDisplayName(resolved.track);

      // Admin interrompendo rádio: para e limpa estado
      if (radioState !== null) {
        player.stop(true);
        if (activeGuildId) {
          const conn = getVoiceConnection(activeGuildId);
          conn?.destroy();
        }
        clearPlayerState();
      }

      const item: QueueItem = {
        title,
        addedBy: interaction.user.id,
        addedByTag: interaction.user.tag ?? interaction.user.username,
        resolved,
      };

      queue.push(item);
      activeTextChannelId = interaction.channelId;
      activeGuildId = interaction.guildId;
      //activeVoiceChannelId = voiceChannel.id;

      // Conecta ao canal de voz se ainda não estiver conectado
      let connection = getVoiceConnection(interaction.guildId);
      if (!connection) {
        connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        });
        try {
          await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        } catch {
          connection.destroy();
          queue.pop();
          await interaction.editReply('Não foi possível conectar ao canal de voz.');
          return;
        }
      }

      // Sempre garante que o player está inscrito na conexão ativa
      connection.subscribe(player);

      const isIdle = player.state.status === AudioPlayerStatus.Idle;
      if (isIdle) {
        await interaction.deleteReply();
        await syncQueueMessage();
        playNextInQueue().catch(err => console.error('[play] erro em playNextInQueue:', err));
      } else {
        await interaction.deleteReply();
        await syncQueueMessage();
      }
    } catch (error) {
      console.error('Erro ao processar /play:', error);
      const msg = normalizePlaybackError(error);
      await interaction.editReply(`Não foi possível reproduzir: ${msg}`);
    }

    return;
  }

  // ── /stop ──────────────────────────────────────────────────────────────────
  if (commandName === 'stop') {
    const member = interaction.member as GuildMember;
    const connection = getVoiceConnection(interaction.guildId);

    if (!connection && radioState === null && currentItem === null && queue.length === 0) {
      await interaction.reply({ content: 'Não estou em nenhum canal de voz.', ephemeral: true });
      return;
    }

    // Verifica permissão
    if (radioState !== null) {
      if (!isAdmin(member) && interaction.user.id !== radioState.startedBy) {
        await interaction.reply({
          content: 'Apenas quem iniciou a rádio ou administradores podem parar a reprodução.',
          ephemeral: true,
        });
        return;
      }
    } else {
      if (!isAdmin(member)) {
        await interaction.reply({
          content: 'Apenas administradores podem parar a playlist.',
          ephemeral: true,
        });
        return;
      }
    }

    player.stop(true);
    await deleteQueueMessage();
    connection?.destroy();
    clearPlayerState();
    await interaction.reply('⏹ Parado e desconectado.');
    return;
  }

  // ── /skip ──────────────────────────────────────────────────────────────────
  if (commandName === 'skip') {
    if (radioState !== null) {
      await interaction.reply({ content: 'Não é possível pular uma rádio. Use `/stop` para parar.', ephemeral: true });
      return;
    }

    if (!currentItem) {
      await interaction.reply({ content: 'Nenhuma música está tocando no momento.', ephemeral: true });
      return;
    }

    const member = interaction.member as GuildMember;
    if (!isAdmin(member) && interaction.user.id !== currentItem.addedBy) {
      await interaction.reply({
        content: 'Apenas quem adicionou a música ou administradores podem pulá-la.',
        ephemeral: true,
      });
      return;
    }

    const skipped = currentItem.title;
    playbackGeneration++; // invalidate any in-flight download for the current track
    currentItem = null;
    isProcessingQueue = false; // libera lock antes de parar
    await syncQueueMessage();
    player.stop(true); // triggers stateChange → Idle → playNextInQueue() when player was active
    // player.stop(true) only emits stateChange when transitioning from a non-Idle state.
    // If the player is already Idle (e.g., between tracks while downloading), trigger directly.
    if (player.state.status === AudioPlayerStatus.Idle && !isProcessingQueue) {
      playNextInQueue().catch(err => console.error('[skip] erro em playNextInQueue:', err));
    }
    await interaction.reply(`⏭ **${skipped}** pulada.`);
    return;
  }

  // ── /queue ─────────────────────────────────────────────────────────────────
  if (commandName === 'queue') {
    if (radioState !== null) {
      await interaction.reply(`📻 Tocando rádio ao vivo: **${radioState.stationName}** ${radioState.emoji}`);
      return;
    }

    const content = buildQueueMessage();
    if (!content) {
      await interaction.reply('📭 A fila esta vazia.');
      return;
    }

    await interaction.reply(content);
    return;
  }

  // ── /random ───────────────────────────────────────────────────────────────
  if (commandName === 'random') {
    if (radioState !== null) {
      await interaction.reply({ content: 'Sugestões aleatórias não estão disponíveis durante rádio ao vivo.', ephemeral: true });
      return;
    }

    if (!currentItem && queue.length === 0) {
      await interaction.reply({
        content: 'A playlist está vazia. Toque ou enfileire músicas antes de usar `/random`.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    try {
      const suggestion = await suggestTrackFromPlaylist(new Set<string>());
      const sent = await interaction.editReply(buildRandomSuggestionMessage(interaction.user.id, suggestion));
      randomSuggestionExclusionsByMessage.set(sent.id, new Set([suggestion.track.SNG_ID]));
    } catch (error) {
      const msg = normalizePlaybackError(error);
      await interaction.editReply(`Não foi possível gerar sugestão: ${msg}`);
    }

    return;
  }

  // ── /remove e /rm ─────────────────────────────────────────────────────────
  if (commandName === 'remove' || commandName === 'rm') {
    if (radioState !== null) {
      await interaction.reply({ content: 'Não há fila ativa durante uma rádio.', ephemeral: true });
      return;
    }

    const pos = interaction.options.getInteger('posicao', true);
    if (pos > queue.length) {
      await interaction.reply({
        content: `Posição inválida. A fila tem **${queue.length}** item(s). Use \`/queue\` para ver.`,
        ephemeral: true,
      });
      return;
    }

    const item = queue[pos - 1];
    const member = interaction.member as GuildMember;
    if (!isAdmin(member) && interaction.user.id !== item.addedBy) {
      await interaction.reply({
        content: 'Apenas quem adicionou a música ou administradores podem removê-la da fila.',
        ephemeral: true,
      });
      return;
    }

    queue.splice(pos - 1, 1);
    await syncQueueMessage();
    await interaction.reply(`🗑 **${item.title}** removida da fila.`);
    return;
  }

  // ── /volume ────────────────────────────────────────────────────────────────
  if (commandName === 'volume') {
    const nivel = interaction.options.getInteger('nivel', true);
    currentVolume = nivel / 100;

    const state = player.state;
    if (state.status !== AudioPlayerStatus.Idle && 'resource' in state) {
      (state.resource as ReturnType<typeof createAudioResource>).volume?.setVolume(currentVolume);
    }

    const volumeContent = `🔊 Volume ajustado para **${nivel}%**`;
    if (volumeMessageId && activeGuildId && activeTextChannelId) {
      try {
        const guild = await client.guilds.fetch(activeGuildId);
        const channel = await guild.channels.fetch(activeTextChannelId) as TextChannel | null;
        const existing = await channel?.messages.fetch(volumeMessageId);
        await existing?.edit(volumeContent);
        await interaction.reply({ content: '\u200b', ephemeral: true });
        await interaction.deleteReply();
        return;
      } catch {
        volumeMessageId = null;
      }
    }

    await interaction.reply(volumeContent);
    const sent = await interaction.fetchReply();
    volumeMessageId = sent.id;
    return;
  }
  } catch (err) {
    console.error('[InteractionCreate] erro não tratado:', err);
    try {
      const reply = { content: 'Ocorreu um erro interno. Tente novamente.', ephemeral: true };
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(reply.content);
        } else {
          await interaction.reply(reply);
        }
      }
    } catch { /* ignora falha ao responder o erro */ }
  }
});

client.login(TOKEN);
