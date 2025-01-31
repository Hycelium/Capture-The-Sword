import {
  startServer,
  PlayerEntity,
  Entity,
  Quaternion,
  RigidBodyType,
  ColliderShape,
  CollisionGroup,
  Block,
  BlockType,
  World,
  Player,
  SceneUI,
  Audio,
  Collider,
} from 'hytopia';

import type { CollisionCallback } from 'hytopia';

import MyEntityController from './MyEntityController';

import worldMap from './assets/map.json';

// Game state
interface GameState {
  redScore: number;
  blueScore: number;
  isRoundActive: boolean;
  timeRemaining: number;
}

const gameData: GameState = {
  redScore: 0,
  blueScore: 0,
  isRoundActive: false,
  timeRemaining: 300, // 5 minutes in seconds
};

// Constants
const LOBBY_COUNTDOWN = 60; // 1 minute warmup
const ROUND_DURATION = 300; // 5 minutes
const RESPAWN_DELAY = 13000; // 13 seconds respawn delay
const SCORE_ZONES = {
  red: 3,  // Red scores at x > 3
  blue: -3 // Blue scores at x < -3
};
const MAP_CENTER_X = 0; // Middle of the map X coordinate
const SCORE_CHECK_INTERVAL = 100; // How often to check for scoring (milliseconds)

let scoreCheckInterval: NodeJS.Timeout | undefined;
let scoreAnnounceInterval: NodeJS.Timeout | undefined;
let countdownInterval: NodeJS.Timeout | undefined;

// Team tracking
const RED_TEAM_PLAYERS = new Set<PlayerEntity>();
const BLUE_TEAM_PLAYERS = new Set<PlayerEntity>();

// Lobby state
let lobbyState: 'awaitingPlayers' | 'starting' | 'inProgress' = 'awaitingPlayers';
let gameCountdownStartTime: number | null = null;
let gameStartTime: number | null = null;

// Sword spawn positions
const SWORD_SPAWNS = {
  red: { x: 45, y: 7, z: -3 },
  blue: { x: -43, y: 7, z: 6 },
};

// Team selection positions
const TEAM_SELECTION_POSITIONS = {
  red: { x: 45, y: 7, z: -4 },
  blue: { x: -44, y: 7, z: 8 },
};

// Simplify the PlayerState interface
interface PlayerState {
  isTagged: boolean;
  respawnTimer?: NodeJS.Timeout;
  lastTagTime?: number;
}

// Add after team tracking
const PLAYER_STATES = new Map<PlayerEntity, PlayerState>();

// Add after other constants
const RANDOM_NAMES = [
  'SwordMaster', 'BladeDancer', 'KnightRider', 'DuelMaster', 'ShadowBlade',
  'StormBringer', 'DragonSlayer', 'PhantomKnight', 'SteelHeart', 'BattleMage',
  'DuskRaider', 'FrostBlade', 'ThunderKnight', 'MysticWarrior', 'BladeRunner',
  'StarChaser', 'DawnBreaker', 'NightStalker', 'LightBringer', 'SkyRider',
  'MoonHunter', 'SunWarrior', 'WindWalker', 'FireDancer', 'IceRunner'
];

const usedNames = new Set<string>();

function getRandomPlayerName(): string {
  const availableNames = RANDOM_NAMES.filter(name => !usedNames.has(name));
  if (availableNames.length === 0) {
    // If all names are used, add a number to a random name
    const baseName = RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)];
    let number = 1;
    while (usedNames.has(`${baseName}${number}`)) {
      number++;
    }
    const newName = `${baseName}${number}`;
    usedNames.add(newName);
    return newName;
  }
  
  const randomName = availableNames[Math.floor(Math.random() * availableNames.length)];
  usedNames.add(randomName);
  return randomName;
}

function createTeamSword(world: World, team: 'red' | 'blue', spawnPosition: { x: number, y: number, z: number }) {
  // First remove any existing swords of this team
  world.entityManager.getAllEntities().forEach(entity => {
    if (entity.name === `${team}_sword` || entity.name === `${team}_sword_child`) {
      entity.despawn();
    }
  });

  // Create new sword
  const sword = new Entity({
    name: `${team}_sword`,
    modelUri: 'models/sword.gltf',
    rigidBodyOptions: {
      type: RigidBodyType.DYNAMIC,
    },
  });

  sword.spawn(world, spawnPosition);

  sword.createAndAddChildCollider({
    shape: ColliderShape.CYLINDER,
    radius: 1,
    halfHeight: 0.5,
    collisionGroups: {
      belongsTo: [ CollisionGroup.ENTITY_SENSOR ],
      collidesWith: [ CollisionGroup.ENTITY ],
    },
    isSensor: true,
    onCollision: (other: Entity | BlockType, started: boolean) => {
      if (started && other instanceof PlayerEntity) {
        const controller = other.controller as MyEntityController;
        // Only opposite team can pick up sword
        if (!controller || controller.sword) return; // Skip if player already has sword
        
        // Prevent tagged players from picking up swords
        const playerState = PLAYER_STATES.get(other) || { isTagged: false };
        if (playerState.isTagged) {
          world.chatManager.sendBroadcastMessage("Cannot pick up sword while tagged!", 'FF0000');
          return;
        }
        
        if ((team === 'red' && controller.team === 'blue') || 
            (team === 'blue' && controller.team === 'red')) {
          const swordChildEntity = new Entity({
            name: `${team}_sword_child`,
            modelUri: 'models/sword.gltf',
            parent: other,
            parentNodeName: 'hand_right_anchor',
          });
          
          swordChildEntity.spawn(
            world,
            { x: 0, y: 0.3, z: 0.5 },
            Quaternion.fromEuler(-90, 0, 90),
          );

          controller.sword = swordChildEntity;
          sword.despawn();
          
          // Play pickup sound and show message
          world.chatManager.sendBroadcastMessage(`${other.player.username} picked up the ${team} team's sword!`, team === 'red' ? 'FF0000' : '0000FF');
        } else {
          world.chatManager.sendBroadcastMessage("You can only pick up the enemy team's sword!", 'FF0000');
        }
      }
    },
  });

  return sword;
}

function spawnTeamSelectionNPCs(world: World) {
  // Spawn red team NPC
  const redNpc = new Entity({
    name: 'Red Team Captain',
    modelUri: 'models/npcs/mindflayer.gltf',
    modelLoopedAnimations: ['idle'],
    modelScale: 0.4,
    rigidBodyOptions: {
      rotation: { x: 0, y: 1, z: 0, w: 0 },
      enabledPositions: { x: false, y: true, z: false },
      enabledRotations: { x: false, y: true, z: false },
      colliders: [
        Collider.optionsFromModelUri('models/npcs/mindflayer.gltf', 0.4),
        {
          shape: ColliderShape.CYLINDER,
          radius: 2,
          halfHeight: 2,
          isSensor: true,
          onCollision: (other: Entity | BlockType, started: boolean) => {
            if (other instanceof PlayerEntity && started) {
              addPlayerToTeam(world, other, 'red');
            }
          }
        }
      ],
    },
  });

  redNpc.spawn(world, TEAM_SELECTION_POSITIONS.red);

  const redTeamUi = new SceneUI({
    templateId: 'team-selection-ui',
    attachedToEntity: redNpc,
    offset: { x: 0, y: 2.5, z: 0 },
  });

  redTeamUi.load(world);

  // Spawn blue team NPC
  const blueNpc = new Entity({
    name: 'Blue Team Captain',
    modelUri: 'models/npcs/mindflayer.gltf',
    modelLoopedAnimations: ['idle'],
    modelScale: 0.4,
    rigidBodyOptions: {
      rotation: { x: 0, y: -1, z: 0, w: 0 },
      enabledPositions: { x: false, y: true, z: false },
      enabledRotations: { x: false, y: true, z: false },
      colliders: [
        Collider.optionsFromModelUri('models/npcs/mindflayer.gltf', 0.4),
        {
          shape: ColliderShape.CYLINDER,
          radius: 2,
          halfHeight: 2,
          isSensor: true,
          onCollision: (other: Entity | BlockType, started: boolean) => {
            if (other instanceof PlayerEntity && started) {
              addPlayerToTeam(world, other, 'blue');
            }
          }
        }
      ],
    },
  });

  blueNpc.spawn(world, TEAM_SELECTION_POSITIONS.blue);

  const blueTeamUi = new SceneUI({
    templateId: 'team-selection-ui',
    attachedToEntity: blueNpc,
    offset: { x: 0, y: 2.5, z: 0 },
  });

  blueTeamUi.load(world);
}

function addPlayerToTeam(world: World, playerEntity: PlayerEntity, team: 'red' | 'blue') {
  // Don't allow team changes during active round
  if (gameData.isRoundActive) {
    world.chatManager.sendBroadcastMessage("Cannot change teams during an active round!", 'FF0000');
    return;
  }

  // Remove from other team if already in it
  RED_TEAM_PLAYERS.delete(playerEntity);
  BLUE_TEAM_PLAYERS.delete(playerEntity);

  // Add to selected team
  if (team === 'red') {
    RED_TEAM_PLAYERS.add(playerEntity);
  } else {
    BLUE_TEAM_PLAYERS.add(playerEntity);
  }

  // Update controller team
  const controller = playerEntity.controller as MyEntityController;
  if (controller) {
    controller.team = team;
  }

  // Update UI with both random name and username
  world.chatManager.sendBroadcastMessage(`${playerEntity.name} (${playerEntity.player.username}) joined ${team} team!`, team === 'red' ? 'FF0000' : '0000FF');
  
  updateUiState(world);

  // Check if we can start the countdown
  if (RED_TEAM_PLAYERS.size >= 1 && BLUE_TEAM_PLAYERS.size >= 1 && lobbyState === 'awaitingPlayers') {
    startGame(world);
    world.chatManager.sendBroadcastMessage('Teams are ready! Game will start in 1 minute!', '00FF00');
    world.chatManager.sendBroadcastMessage('More players can still join during the countdown!', '00FF00');
  }
}

function updateUiState(world: World) {
  const uiState = {
    redTeamCount: RED_TEAM_PLAYERS.size,
    blueTeamCount: BLUE_TEAM_PLAYERS.size,
    gameState: lobbyState,
    scores: {
      red: gameData.redScore,
      blue: gameData.blueScore,
    },
    timeRemaining: gameData.timeRemaining,
    teams: {
      red: Array.from(RED_TEAM_PLAYERS).map(p => `${p.name} (${p.player.username})`),
      blue: Array.from(BLUE_TEAM_PLAYERS).map(p => `${p.name} (${p.player.username})`),
    },
  };

  // Send UI update to all players with their individual stamina values
  const players = Array.from(RED_TEAM_PLAYERS).concat(Array.from(BLUE_TEAM_PLAYERS));
  players.forEach(entity => {
    const controller = entity.controller as MyEntityController;
    const playerUiState = {
      ...uiState,
      stamina: {
        current: controller.currentStamina,
        max: controller.maxStamina
      }
    };
    entity.player.ui.sendData(playerUiState);
  });
}

function startGame(world: World) {
  lobbyState = 'starting';
  gameStartTime = Date.now();
  
  // Start countdown
  gameData.timeRemaining = LOBBY_COUNTDOWN;
  
  // Update UI every second during countdown
  countdownInterval = setInterval(() => {
    gameData.timeRemaining--;
    updateUiState(world);
    
    // Announce time remaining at specific intervals
    if (gameData.timeRemaining <= 10 || 
        gameData.timeRemaining === 30 || 
        gameData.timeRemaining === 60) {
      world.chatManager.sendBroadcastMessage(`Game starting in ${gameData.timeRemaining} seconds!`, '00FF00');
    }
    
    if (gameData.timeRemaining <= 0) {
      clearInterval(countdownInterval);
      startRound(world);
    }
  }, 1000);
  
  updateUiState(world);
}

function startRound(world: World) {
  lobbyState = 'inProgress';
  gameData.isRoundActive = true;
  gameData.timeRemaining = ROUND_DURATION;
  gameData.redScore = 0;
  gameData.blueScore = 0;
  
  // Reset positions and spawn swords
  resetAfterScore(world);
  
  world.chatManager.sendBroadcastMessage('Round started! You have 5 minutes!', '00FF00');
  
  // Start score checking
  scoreCheckInterval = setInterval(() => {
    checkForScoring(world);
    updateRoundTimer(world);
  }, SCORE_CHECK_INTERVAL);
  
  // Announce score every minute
  scoreAnnounceInterval = setInterval(() => {
    if (!gameData.isRoundActive) {
      clearInterval(scoreAnnounceInterval);
      return;
    }
    world.chatManager.sendBroadcastMessage(`Current Score - Red: ${gameData.redScore}, Blue: ${gameData.blueScore}`, 'FFFF00');
  }, 60000);
  
  updateUiState(world);
}

function updateRoundTimer(world: World) {
  if (!gameData.isRoundActive) return;

  gameData.timeRemaining = Math.max(0, gameData.timeRemaining - (SCORE_CHECK_INTERVAL / 1000));
  updateUiState(world);

  // End game when time runs out
  if (gameData.timeRemaining <= 0) {
    endGame(world);
  }
}

function checkForScoring(world: World) {
  if (!gameData.isRoundActive) return;

  // Check all players for scoring conditions
  const allPlayers = [...RED_TEAM_PLAYERS, ...BLUE_TEAM_PLAYERS];
  
  allPlayers.forEach(playerEntity => {
    const controller = playerEntity.controller as MyEntityController;
    if (!controller?.sword) return;

    const playerX = playerEntity.position.x;
    const team = controller.team;
    
    // Red team scores by crossing to positive X with blue sword
    if (team === 'red' && controller.sword.name === 'blue_sword_child') {
      // Only score and reset when crossing scoring line
      if (playerX > SCORE_ZONES.red) {
        addScore(world, 'red');
        resetAfterScore(world);
      }
    }
    // Blue team scores by crossing to negative X with red sword
    else if (team === 'blue' && controller.sword.name === 'red_sword_child') {
      // Only score and reset when crossing scoring line
      if (playerX < SCORE_ZONES.blue) {
        addScore(world, 'blue');
        resetAfterScore(world);
      }
    }
  });
}

function addScore(world: World, team: 'red' | 'blue') {
  if (team === 'red') {
    gameData.redScore++;
  } else {
    gameData.blueScore++;
  }
  
  world.chatManager.sendBroadcastMessage(`${team.toUpperCase()} team scored! Red: ${gameData.redScore}, Blue: ${gameData.blueScore}`, 'FFFF00');
  updateUiState(world);
}

function resetAfterScore(world: World) {
  // First, remove ALL swords from the world (both carried and spawned)
  const allPlayers = [...RED_TEAM_PLAYERS, ...BLUE_TEAM_PLAYERS];
  
  // Remove carried swords from players
  allPlayers.forEach(playerEntity => {
    const controller = playerEntity.controller as MyEntityController;
    if (controller?.sword) {
      controller.sword.despawn();
      controller.sword = undefined;
    }
  });

  // Remove any loose swords in the world
  world.entityManager.getAllEntities().forEach(entity => {
    if (entity.name === 'red_sword' || entity.name === 'blue_sword') {
      entity.despawn();
    }
  });

  // Reset player positions based on their team
  allPlayers.forEach(playerEntity => {
    const controller = playerEntity.controller as MyEntityController;
    if (controller?.team === 'red') {
      playerEntity.setPosition({ x: 45, y: 7, z: 4 });
    } else if (controller?.team === 'blue') {
      playerEntity.setPosition({ x: -44, y: 7, z: -4 });
    }
  });

  // Wait a short moment for cleanup, then spawn new swords
  setTimeout(() => {
    // Spawn exactly one sword for each team
    createTeamSword(world, 'red', SWORD_SPAWNS.red);
    createTeamSword(world, 'blue', SWORD_SPAWNS.blue);
    world.chatManager.sendBroadcastMessage('New swords have spawned!', '00FF00');
  }, 500);
}

// Add cleanup function
function cleanupGameState(world: World) {
  // Clear all intervals
  [scoreCheckInterval, scoreAnnounceInterval, countdownInterval].forEach(interval => {
    if (interval) {
      clearInterval(interval);
    }
  });
  scoreCheckInterval = undefined;
  scoreAnnounceInterval = undefined;
  countdownInterval = undefined;

  // Clear all player states and timers
  PLAYER_STATES.forEach((state, player) => {
    if (state.respawnTimer) {
      clearTimeout(state.respawnTimer);
    }
  });
  PLAYER_STATES.clear();

  // Clear all sword entities
  world.entityManager.getAllEntities().forEach(entity => {
    if (entity.name?.includes('sword')) {
      entity.despawn();
    }
  });

  // Reset all players
  const allPlayers = [...RED_TEAM_PLAYERS, ...BLUE_TEAM_PLAYERS];
  allPlayers.forEach(playerEntity => {
    const controller = playerEntity.controller as MyEntityController;
    if (controller) {
      // Clear sword references
      if (controller.sword) {
        controller.sword.despawn();
        controller.sword = undefined;
      }
      // Reset movement abilities
      controller.canWalk = () => true;
      controller.canJump = () => true;
      controller.canRun = () => true;
      // Clear team
      controller.team = undefined;
    }
    // Reset position
    playerEntity.setPosition({ x: 0, y: 10, z: 0 });
  });

  // Clear team sets
  RED_TEAM_PLAYERS.clear();
  BLUE_TEAM_PLAYERS.clear();

  // Reset game data
  gameData.redScore = 0;
  gameData.blueScore = 0;
  gameData.isRoundActive = false;
  gameData.timeRemaining = ROUND_DURATION;

  // Reset lobby state
  lobbyState = 'awaitingPlayers';
  gameStartTime = null;
  gameCountdownStartTime = null;

  // Clear used names (only if they're not currently in use)
  const currentPlayers = world.entityManager.getAllEntities()
    .filter(e => e instanceof PlayerEntity)
    .map(e => e.name);
  
  usedNames.forEach(name => {
    if (!currentPlayers.includes(name)) {
      usedNames.delete(name);
    }
  });

  // Update UI for all connected players
  updateUiState(world);
}

// Modify endGame to use cleanup
function endGame(world: World) {
  gameData.isRoundActive = false;
  
  // Determine winner before cleanup
  const winner = gameData.redScore > gameData.blueScore ? 'red' : 
                gameData.blueScore > gameData.redScore ? 'blue' : 'tie';
  
  // Announce results
  if (winner === 'tie') {
    world.chatManager.sendBroadcastMessage('Game Over - It\'s a tie!', 'FFFF00');
  } else {
    world.chatManager.sendBroadcastMessage(`Game Over - ${winner.toUpperCase()} team wins!`, 'FFFF00');
  }
  world.chatManager.sendBroadcastMessage(`Final Scores - Red: ${gameData.redScore}, Blue: ${gameData.blueScore}`, 'FFFF00');
  
  // Reset game state after 1 minute
  setTimeout(() => {
    cleanupGameState(world);
    world.chatManager.sendBroadcastMessage('Game reset! Join a team to start a new game!', '00FF00');
  }, 60000); // 1 minute delay
}

// Update tag handling function
function handlePlayerTag(world: World, taggedPlayer: PlayerEntity, tagger: PlayerEntity) {
  const controller = taggedPlayer.controller as MyEntityController;
  const taggedState = PLAYER_STATES.get(taggedPlayer) || { isTagged: false };
  
  // Don't tag if recently tagged or currently tagged
  const now = Date.now();
  if (taggedState.isTagged || 
      (taggedState.lastTagTime && now - taggedState.lastTagTime < 1000)) {
    return;
  }

  // Apply tag only to the tagged player
  taggedState.isTagged = true;
  taggedState.lastTagTime = now;
  PLAYER_STATES.set(taggedPlayer, taggedState);

  // Freeze only the tagged player
  controller.canWalk = () => !taggedState.isTagged;
  controller.canJump = () => !taggedState.isTagged;
  controller.canRun = () => !taggedState.isTagged;

  // Drop sword if tagged player has one
  if (controller.sword) {
    controller.sword.despawn();
    controller.sword = undefined;
    world.chatManager.sendBroadcastMessage(`${taggedPlayer.name} dropped their sword!`, 'FFFF00');
  }

  // Notify players
  world.chatManager.sendBroadcastMessage(
    `${taggedPlayer.name} (${taggedPlayer.player.username}) was tagged by ${tagger.name} (${tagger.player.username})! Respawning in ${RESPAWN_DELAY/1000} seconds...`, 
    'FFFF00'
  );

  // Start respawn timer only for tagged player
  taggedState.respawnTimer = setTimeout(() => {
    // Unfreeze tagged player
    taggedState.isTagged = false;
    controller.canWalk = () => true;
    controller.canJump = () => true;
    controller.canRun = () => true;

    // Return tagged player to their base
    const spawnPos = controller.team === 'red' 
      ? { x: 45, y: 7, z: 4 } 
      : { x: -44, y: 7, z: -4 };
    taggedPlayer.setPosition(spawnPos);

    world.chatManager.sendBroadcastMessage(`${taggedPlayer.name} has respawned!`, '00FF00');
  }, RESPAWN_DELAY) as NodeJS.Timeout;
}

startServer(world => {
  // Uncomment this to visualize physics vertices, will cause noticable lag.
  // world.simulation.enableDebugRendering(true);
  

  /**
   * Load our map.
   * You can build your own map using https://build.hytopia.com
   * After building, hit export and drop the .json file in
   * the assets folder as map.json.
   */
  const typedWorldMap = {
    ...worldMap,
    entities: Object.fromEntries(
      Object.entries(worldMap.entities).map(([key, value]) => [
        key,
        {
          ...value,
          rigidBodyOptions: value.rigidBodyOptions ? {
            ...value.rigidBodyOptions,
            type: value.rigidBodyOptions.type as RigidBodyType
          } : undefined
        }
      ])
    )
  };

  world.loadMap(typedWorldMap);

  // Spawn team selection NPCs
  spawnTeamSelectionNPCs(world);

  world.onPlayerJoin = player => {
    // Load UI
    player.ui.load('ui/index.html');
    
    // Create player entity with random name
    const randomName = getRandomPlayerName();
    const playerEntity = new PlayerEntity({
      player,
      name: randomName,
      modelUri: 'models/players/player.gltf',
      modelLoopedAnimations: [ 'idle' ],
      modelScale: 0.5,
      controller: new MyEntityController(),
    });

    // Add collision handler for scoring
    playerEntity.onBlockCollision = (entity: Entity, blockType: BlockType, started: boolean) => {
      if (started) {
        const controller = entity.controller as MyEntityController;
        if (!controller?.sword) return;
        
        // Play sound or show effect when touching scoring blocks
        // But actual scoring is handled by checkForScoring
      }
    };

    // Modify the player collision handler
    playerEntity.onEntityCollision = (entity: Entity, otherEntity: Entity, started: boolean) => {
      if (!started || !gameData.isRoundActive) return;
      
      // Only handle collisions between players
      if (!(entity instanceof PlayerEntity) || !(otherEntity instanceof PlayerEntity)) return;

      const controller = entity.controller as MyEntityController;
      const otherController = otherEntity.controller as MyEntityController;

      // Check if this is a collision between players from different teams
      if (controller?.team && otherController?.team && controller.team !== otherController.team) {
        // Handle sword collisions separately
        if (controller.sword || otherController.sword) {
          world.chatManager.sendBroadcastMessage('Player collision! Resetting positions...', 'FFFF00');
          resetAfterScore(world);
          return;
        }

        // Determine if players are in their territories
        const entityX = entity.position.x;
        const otherEntityX = otherEntity.position.x;
        
        // Define territories
        // Red territory: x > 2
        // Blue territory: x < 0
        const entityInRedTerritory = entityX > 1;
        const entityInBlueTerritory = entityX < 1;
        const otherInRedTerritory = otherEntityX > 1;
        const otherInBlueTerritory = otherEntityX < 1;
        
        // Allow tagging only when players are in their own territory
        const entityCanTag = (controller.team === 'red' && entityInRedTerritory) || 
                           (controller.team === 'blue' && entityInBlueTerritory);
        const otherCanTag = (otherController.team === 'red' && otherInRedTerritory) || 
                          (otherController.team === 'blue' && otherInBlueTerritory);

        if (entityCanTag && !otherCanTag) {
          // Entity is in their territory and other is not - tag the other player
          handlePlayerTag(world, otherEntity, entity);
          world.chatManager.sendBroadcastMessage(`${entity.name} defended their territory!`, controller.team === 'red' ? 'FF0000' : '0000FF');
        } else if (otherCanTag && !entityCanTag) {
          // Other is in their territory and entity is not - tag the entity
          handlePlayerTag(world, entity, otherEntity);
          world.chatManager.sendBroadcastMessage(`${otherEntity.name} defended their territory!`, otherController.team === 'red' ? 'FF0000' : '0000FF');
        }
      }
    };

    playerEntity.spawn(world, { x: 0, y: 10, z: 0 });
    
    // Send current game state
    updateUiState(world);
    
    // Send clearer game instructions
    world.chatManager.sendBroadcastMessage('=== Welcome to Capture the Sword! ===', '00FF00');
    world.chatManager.sendBroadcastMessage('Game Rules:', '00FF00');
    world.chatManager.sendBroadcastMessage('1. Join a team by approaching the team captains', '00FF00');
    world.chatManager.sendBroadcastMessage('2. Steal the enemy team\'s sword and bring it to your scoring zone', '00FF00');
    world.chatManager.sendBroadcastMessage('3. Tag enemy players to freeze them for 8 seconds', '00FF00');
    world.chatManager.sendBroadcastMessage('4. If you\'re carrying a sword and get tagged, the sword resets', '00FF00');
    world.chatManager.sendBroadcastMessage('5. Team with most points after 5 minutes wins!', '00FF00');
  };

  world.onPlayerLeave = player => {
    const entities = world.entityManager.getPlayerEntitiesByPlayer(player);
    entities.forEach(entity => {
      // Remove name from used names
      usedNames.delete(entity.name);
      
      // Remove from teams
      RED_TEAM_PLAYERS.delete(entity);
      BLUE_TEAM_PLAYERS.delete(entity);
      
      // Clear any respawn timers
      const playerState = PLAYER_STATES.get(entity);
      if (playerState?.respawnTimer) {
        clearTimeout(playerState.respawnTimer);
      }
      PLAYER_STATES.delete(entity);

      // If player had a sword, clean it up
      const controller = entity.controller as MyEntityController;
      if (controller?.sword) {
        controller.sword.despawn();
        controller.sword = undefined;
      }
      
      // Despawn entity
      entity.despawn();
    });
    
    // If no players left, do full cleanup
    const remainingPlayers = world.entityManager.getAllEntities()
      .filter(e => e instanceof PlayerEntity);
    if (remainingPlayers.length === 0) {
      cleanupGameState(world);
    } else {
      // Just update UI for remaining players
      updateUiState(world);
    }
  };
});
