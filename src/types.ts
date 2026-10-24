export type Talk = {
  // Pretalx code, e.g. RPAPTP
  code: string;
  // Devcon API session id (slug), used for the devcon.org card URL
  id: string;
  title: string;
  room: string;
  // Epoch milliseconds
  start: number;
  doNotRecord: boolean;
  // Official AV intro card, path under public/
  card: string;
};

export type TalksFile = {
  event: string;
  talks: Talk[];
};
