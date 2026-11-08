// The three coaches. Each one has its own look and natural (Kokoro) voice.
export const COACHES = {
  maya: {
    name: 'Maya',
    voice: 'heart',
    tagline: 'Warm and encouraging',
    piece: 'Q',
    gradient: 'radial-gradient(circle at 30% 25%, #5fe0c7, #26c2a3 58%, #13806b)',
    hello: "Hi, I'm Maya! Let's find the moments that decided your game.",
  },
  leo: {
    name: 'Leo',
    voice: 'michael',
    tagline: 'Calm and analytical',
    piece: 'N',
    gradient: 'radial-gradient(circle at 30% 25%, #a3d160, #81b64c 58%, #45753c)',
    hello: "I'm Leo. We'll go through every move together, calmly and clearly.",
  },
  bella: {
    name: 'Bella',
    voice: 'bella',
    tagline: 'Bright and energetic',
    piece: 'B',
    gradient: 'radial-gradient(circle at 30% 25%, #c7a6ff, #8f6bd6 58%, #563c94)',
    hello: "Hey, I'm Bella! Ready? Let's see what you did brilliantly today!",
  },
};

export const COACH_IDS = Object.keys(COACHES);
