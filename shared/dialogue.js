// NPC dialogue banks — plain data, importable by client and server.
// Convention: pick lines at random for ambient "barks"; ordered arrays (quests/story) play in sequence.
// {p} is replaced with the player's name/id at display time.

export const NPCS = {
  villager:  { sprite: 'villager',  name: 'Hearthfolk Survivor' },
  villager2: { sprite: 'villager2', name: 'Hearthfolk Forager' },
  tribal:    { sprite: 'tribal',    name: 'Ashmark Hunter' },
  shaman:    { sprite: 'shaman',    name: 'Elder Yvenne, Ashmark Shaman' }
};

// ---------- ambient barks (random, repeatable) ----------
export const BARKS = {
  villager: [
    "Another Keeper? The Hearth must be desperate.",
    "The soil remembers every tree you fell. Take gently, or it turns to mire.",
    "We had a whole village once. Now we have a fire and each other.",
    "If you hear the night humming, get behind walls. The humming is them.",
    "My grandmother said the Monoliths used to sing at dawn. I've never heard it.",
    "Don't carry raw meat after dark. They smell it. They always smell it.",
    "The rain is honest weather. The purple storms are not weather at all.",
    "Campfires keep the rot off the timber. Never let yours die."
  ],
  villager2: [
    "Berries from the bushes, fiber from the stalks. The Hearth still gives, if you ask politely.",
    "I saw a wisp float over the west ridge yesterday. The ground it touched went dark.",
    "Boil your water? Ha. Just don't drink where the toads sing.",
    "The mud swallowed my boots and nearly me with them. Watch the dead sectors.",
    "A trader left a journal here once. Said he'd sailed east and found gold dunes. Mad, we thought.",
    "Snow foxes are quick, but hares are quicker. Aim for the boar if you're hungry."
  ],
  tribal: [
    "You walk loud, Keeper. The Blight has ears in the soil.",
    "My spear has drunk crawler ichor for three winters. It is still thirsty.",
    "We Ashmark do not fear the night. We fear the nights when nothing comes.",
    "The white teeth in the southern sea ate my brother's boat. Bind your hull in fallen stars.",
    "A brute smashed our palisade in two blows. Build in stone thoughts, even when you build in wood.",
    "The stalkers learn your paths. Change them.",
    "Meat shared is meat doubled. Sit. Eat."
  ],
  shaman: [
    "The Hearth is not dying, Keeper. It is being digested. There is a difference — and a cure.",
    "Four songs, four islands, one engine. The old ones built the cure and then forgot to use it.",
    "The wisps are not the disease. They are its fingers. The hand waits at the heart of the sea.",
    "Starmetal fell before the Blight came. The sky was trying to arm us. Most of it sank into the far isles.",
    "Dig deep and the world shows you its bones — iron, and eyes of diamond. Bring light. The dark below is older than the dark above.",
    "Every Monolith you wake, the parasite wakes a little more. Expect worse. Be worse back.",
    "When the Engine turns, the sky will scream for four minutes. Hold, and the Hearth is yours again."
  ]
};

// ---------- contextual event lines (triggered, random within category) ----------
export const EVENT_LINES = {
  nightFall: [
    "Elder Yvenne: 'The purple hour. Stand in the light, Keeper.'",
    "Hunter: 'They rise. Spears up.'"
  ],
  blightStorm: [
    "Survivor: 'The storm eats bare timber! Is the campfire lit?!'"
  ],
  sandstorm: ["Hunter: 'The dunes are angry. Put a wall between you and the wind!'"],
  snowstorm: ["Forager: 'This cold kills cloaked or not — find fire!'"],
  firstMonolith: [
    "Elder Yvenne: 'One song returns. Do you feel the ground listening? So does IT.'"
  ],
  monolith: [
    "Elder Yvenne: 'Another voice joins the choir. The sea-wound stirs.'"
  ],
  allMonoliths: [
    "Elder Yvenne: 'The choir is whole. Now — the wound at the heart of the sea. Build the Engine. End this.'"
  ],
  waveStart: [
    "Elder Yvenne: 'IT KNOWS. Everything it has left is coming. Four minutes, Keepers. HOLD.'"
  ],
  victory: [
    "Elder Yvenne: 'The song holds. The Blight recedes... The Hearth remembers your names.'"
  ],
  playerDown: ["Hunter: 'A Keeper fell! The fire will carry them back.'"],
  bruteSighted: ["Hunter: 'SIEGE-BEAST! It wants the walls, not you — decide which you save.'"]
};

// ---------- shaman hint chain (ordered; give the next unheard line) ----------
export const SHAMAN_HINTS = [
  "Start simply: wood, a workbench, an axe. The Hearth rewards patient hands.",
  "Fire is a promise to the night. Make camp before the purple hour.",
  "Stone tools open stone hearts. The loose rocks are the world's small gifts.",
  "A boat of honest wood will carry you east and south. Not west of south — not yet.",
  "Follow the traders' notes. They died learning the map so you would not.",
  "The fallen-star metal hides on three isles. The frozen isle demands it as a toll.",
  "Crystal sleeps in the Spire's ice. Essence beats in the Blight's children. The Forge marries them into Cores.",
  "Four Cores, four Monoliths. Then the center. Then the storm of storms. Then, perhaps, morning."
];
