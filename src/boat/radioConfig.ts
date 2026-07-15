/** Direct laut.fm cast hosts — the short stream.laut.fm URLs 302 without CORS headers. */
function lautStreamUrl(slug: string): string {
  return `https://${slug}.stream.laut.fm/${slug}`;
}

export const radioStations = [
  {
    id: "electronic",
    name: "1000 Electronic Dance Music",
    genre: "Electrónica",
    url: lautStreamUrl("1000-electronic-dance-music"),
  },
  {
    id: "rock",
    name: "Rock FM",
    genre: "Rock",
    url: lautStreamUrl("rock-fm"),
  },
  {
    id: "jazz",
    name: "JustJazz",
    genre: "Jazz",
    url: lautStreamUrl("justjazz"),
  },
  {
    id: "metal",
    name: "Metalstation",
    genre: "Metal",
    url: lautStreamUrl("metalstation"),
  },
  {
    id: "mixed",
    name: "AlMusic Radio",
    genre: "Variada",
    url: lautStreamUrl("almusic-radio"),
  },
  {
    id: "pop",
    name: "World Hits Radio",
    genre: "Pop",
    url: lautStreamUrl("worldhitsradio"),
  },
] as const;

export type RadioStationId = (typeof radioStations)[number]["id"];

export const RADIO_STATION_COUNT = radioStations.length;
