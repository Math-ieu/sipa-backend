export type Suit = 'spades' | 'hearts' | 'diamonds' | 'clubs';
export type Rank = '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  id: string;
  suit: Suit;
  rank: Rank;
  value: number; // 7 = 1, 8 = 2, ..., A = 8
}

export interface Player {
  id: string;
  name: string;
  score: number;
  hand: Card[];
  isAI: boolean;
  isHost?: boolean;
  avatarId?: string;
}

export interface TrickPlayedCard {
  playerId: string;
  card: Card;
  playerName: string;
}

export interface TrickResult {
  trickIndex: number;
  leadPlayerId: string;
  winnerId: string;
  winningCard: Card;
  playedCards: TrickPlayedCard[];
}

export interface RoundResult {
  roundNumber: number;
  winnerId: string;
  pointsGained: number;
  winningStreak: number;
  reason: string;
}

export interface ActiveVote {
  initiatorId: string;
  initiatorName: string;
  action: 'cancel' | 'end' | 'pause' | 'resume';
  votes: Record<string, boolean>; // playerId -> yes/no
  expiresAt: number;
}

export interface RoundHistoryEntry {
  roundNumber: number;
  tricks: TrickResult[];
}

export interface GameState {
  roomId: string | null;
  players: Player[];
  deck: Card[];
  currentRound: number;
  currentTrickIndex: number;
  currentLeaderId: string;
  currentTrickCards: TrickPlayedCard[];
  activePlayerIndex: number;
  tricksHistory: TrickResult[];
  status: 'lobby' | 'playing' | 'round_end' | 'game_over' | 'paused' | 'canceled'; // Add paused & canceled statuses
  winnerId: string | null;
  lastRoundResult: RoundResult | null;
  dealerId: string;
  gameMode: 'ai' | 'pass_and_play' | 'online';
  activeVote?: ActiveVote | null;
  roundsHistory?: RoundHistoryEntry[];
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  avatarId?: string;
  text: string;
  timestamp: string;
}
