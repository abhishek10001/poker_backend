import roomManager from '../src/services/roomManager.js';

describe('Poker Game Room & Wealth Management Features', () => {
  let gameId;
  let hostId;
  let bobId;

  test('1. Room creation with Host Initial Money', async () => {
    const createResult = await roomManager.createRoom('HostAlice', {
      bootAmount: 100,
      maxRaiseMultiplier: 8,
      maxPlayers: 4,
      turnTimerSeconds: 30,
      chipLabel: '₹',
    }, 5000);

    gameId = createResult.gameId;
    hostId = createResult.hostPlayerId;
    const room = roomManager.getRoom(gameId);

    expect(room).toBeDefined();
    expect(room.players.get(hostId).wallet).toBe(5000);
    expect(room.players.get(hostId).totalBuyIn).toBe(5000);
  });

  test('2. Reconnection preserves wallet & status', async () => {
    const room = roomManager.getRoom(gameId);
    const joinResult = await roomManager.joinRoom(gameId, 'Bob', 2000);
    bobId = joinResult.playerId;

    // Simulate play/change then disconnect
    room.players.get(bobId).wallet = 1800;
    room.players.get(bobId).connected = false;

    // Reconnect with same display name
    const reconnectResult = await roomManager.joinRoom(gameId, 'Bob', 9999);
    expect(reconnectResult.reconnected).toBe(true);
    expect(room.players.get(reconnectResult.playerId).wallet).toBe(1800);
  });

  test('3. Manual boot button functionality', async () => {
    const room = roomManager.getRoom(gameId);
    room.startRound();

    expect(room.pot).toBe(0);
    expect(room.players.get(hostId).hasBooted).toBe(false);
    expect(room.players.get(hostId).status).toBe('waiting');

    // Host boots
    room.processAction(hostId, { action: 'BOOT' });
    expect(room.pot).toBe(100);
    expect(room.players.get(hostId).wallet).toBe(4900);
    expect(room.players.get(hostId).hasBooted).toBe(true);
    expect(room.players.get(hostId).status).toBe('blind');

    // Bob boots
    room.processAction(bobId, { action: 'BOOT' });
    expect(room.pot).toBe(200);
    expect(room.players.get(bobId).wallet).toBe(1700);
    expect(room.players.get(bobId).hasBooted).toBe(true);
  });

  test('4. Dynamic Max Raise based on Current Stake * Multiplier', () => {
    const room = roomManager.getRoom(gameId);
    // Current stake = 100, max multiplier = 8 -> max stake is 800
    expect(() => {
      room.processAction(hostId, { action: 'RAISE', amount: 850 });
    }).toThrow(/maximum allowed/);

    const raiseRes = room.processAction(hostId, { action: 'RAISE', amount: 800 });
    expect(room.currentStake).toBe(800);
    expect(room.pot).toBe(1000); // 200 + 800
  });

  test('5. All-In Action', async () => {
    const room = roomManager.getRoom(gameId);
    const charlieJoin = await roomManager.joinRoom(gameId, 'Charlie', 500);
    const charlieId = charlieJoin.playerId;

    room.processAction(charlieId, { action: 'BOOT' }); // remaining wallet = 400
    room.processAction(charlieId, { action: 'ALL_IN' });

    expect(room.players.get(charlieId).wallet).toBe(0);
    expect(room.players.get(charlieId).status).toBe('all_in');
  });

  test('6. Host Add Money feature', () => {
    const room = roomManager.getRoom(gameId);
    const prevWallet = room.players.get(bobId).wallet;
    const newWallet = room.addMoney(bobId, 1000);

    expect(newWallet).toBe(prevWallet + 1000);
    expect(room.players.get(bobId).wallet).toBe(prevWallet + 1000);
    expect(room.players.get(bobId).totalBuyIn).toBe(2000 + 1000);
  });
});
