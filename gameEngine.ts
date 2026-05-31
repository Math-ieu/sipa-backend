import { Card, Suit, Rank, Player, TrickPlayedCard, TrickResult, RoundResult } from './types';

export const SUITS: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'];
export const RANKS: Rank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export const SUIT_SYMBOLS: Record<Suit, string> = {
  spades: '♠',
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
};

export const SUIT_COLORS: Record<Suit, string> = {
  spades: 'text-slate-900 dark:text-slate-100',
  hearts: 'text-red-500',
  diamonds: 'text-blue-500 dark:text-blue-400',
  clubs: 'text-emerald-700 dark:text-emerald-500',
};

export const SUIT_LABELS: Record<Suit, string> = {
  spades: 'Pique',
  hearts: 'Cœur',
  diamonds: 'Carreau',
  clubs: 'Trèfle',
};

export function getRankValue(rank: Rank): number {
  switch (rank) {
    case '7': return 1;
    case '8': return 2;
    case '9': return 3;
    case '10': return 4;
    case 'J': return 5;
    case 'Q': return 6;
    case 'K': return 7;
    case 'A': return 8;
  }
}

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({
        id: `${suit}-${rank}`,
        suit,
        rank,
        value: getRankValue(rank),
      });
    }
  }
  return deck;
}

export function shuffleDeck(deck: Card[]): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function dealCards(deck: Card[], playersCount: number): { hands: Card[][]; remainingDeck: Card[] } {
  const shuffled = shuffleDeck(deck);
  const hands: Card[][] = Array.from({ length: playersCount }, () => []);
  let deckIndex = 0;
  
  for (let round = 0; round < 3; round++) {
    for (let p = 0; p < playersCount; p++) {
      if (deckIndex < shuffled.length) {
        hands[p].push(shuffled[deckIndex++]);
      }
    }
  }
  
  for (let round = 0; round < 2; round++) {
    for (let p = 0; p < playersCount; p++) {
      if (deckIndex < shuffled.length) {
        hands[p].push(shuffled[deckIndex++]);
      }
    }
  }
  
  for (let p = 0; p < playersCount; p++) {
    hands[p].sort((a, b) => {
      if (a.suit !== b.suit) {
        return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
      }
      return b.value - a.value;
    });
  }
  
  return {
    hands,
    remainingDeck: shuffled.slice(deckIndex),
  };
}

export function canPlayCard(card: Card, hand: Card[], leadCard: Card | null): boolean {
  if (!leadCard) {
    return true;
  }
  const hasMatchingSuit = hand.some(c => c.suit === leadCard.suit);
  if (hasMatchingSuit) {
    return card.suit === leadCard.suit;
  }
  return true;
}

export function getCurrentWinningPlay(playedCards: TrickPlayedCard[], startingSuit: Suit): TrickPlayedCard | null {
  const matchingPlays = playedCards.filter(p => p.card.suit === startingSuit);
  if (matchingPlays.length === 0) return null;
  
  return matchingPlays.reduce((highest, current) => 
    current.card.value > highest.card.value ? current : highest
  , matchingPlays[0]);
}

export function determineTrickWinner(playedCards: TrickPlayedCard[], startingSuit: Suit): string {
  const winningPlay = getCurrentWinningPlay(playedCards, startingSuit);
  if (!winningPlay) {
    throw new Error('No matching cards found for the starting suit.');
  }
  return winningPlay.playerId;
}

export function calculateRoundResult(tricks: TrickResult[], roundNumber: number): RoundResult {
  if (tricks.length < 5) {
    throw new Error('A round must have exactly 5 tricks.');
  }
  
  const lastTrickIdx = tricks.length - 1;
  const winnerId = tricks[lastTrickIdx].winnerId;
  const lastWinningCard = tricks[lastTrickIdx].winningCard;
  
  let pointsGained = 0;
  let winningStreak_7s = 0;
  let reason = '';
  
  if (lastWinningCard.rank === '7') {
    winningStreak_7s = 1;
    for (let t = lastTrickIdx - 1; t >= 0; t--) {
      const trick = tricks[t];
      if (trick.winnerId === winnerId && trick.winningCard.rank === '7') {
        winningStreak_7s++;
      } else {
        break;
      }
    }
    pointsGained = winningStreak_7s * 2;
    reason = `Victoire avec ${winningStreak_7s} dernier(s) 7 gagnant(s) successif(s) (+${pointsGained} points)`;
  } else {
    pointsGained = 1;
    reason = `Victoire avec un dernier pli non-7 (${lastWinningCard.rank} de ${SUIT_LABELS[lastWinningCard.suit]}) (+1 point)`;
  }
  
  return {
    roundNumber,
    winnerId,
    pointsGained,
    winningStreak: winningStreak_7s,
    reason,
  };
}

export function selectAICard(hand: Card[], currentTrickCards: TrickPlayedCard[], leadCard: Card | null): Card {
  if (hand.length === 0) {
    throw new Error('AI cannot play: hand is empty');
  }

  if (!leadCard) {
    const non7Cards = hand.filter(c => c.rank !== '7');
    if (hand.length <= 2) {
      return hand.reduce((max, card) => card.value > max.value ? card : max, hand[0]);
    }
    if (non7Cards.length > 0) {
      return non7Cards.reduce((min, card) => card.value < min.value ? card : min, non7Cards[0]);
    } else {
      return hand.reduce((min, card) => card.value < min.value ? card : min, hand[0]);
    }
  }

  const startingSuit = leadCard.suit;
  const matchingCards = hand.filter(c => c.suit === startingSuit);
  const currentWinningPlay = getCurrentWinningPlay(currentTrickCards, startingSuit);
  const targetValue = currentWinningPlay ? currentWinningPlay.card.value : leadCard.value;

  if (matchingCards.length > 0) {
    const winningCards = matchingCards.filter(c => c.value > targetValue);
    if (winningCards.length > 0) {
      return winningCards.reduce((min, card) => card.value < min.value ? card : min, winningCards[0]);
    } else {
      return matchingCards.reduce((min, card) => card.value < min.value ? card : min, matchingCards[0]);
    }
  }

  const non7Cards = hand.filter(c => c.rank !== '7');
  if (non7Cards.length > 0) {
    return non7Cards.reduce((min, card) => card.value < min.value ? card : min, non7Cards[0]);
  } else {
    return hand.reduce((min, card) => card.value < min.value ? card : min, hand[0]);
  }
}
