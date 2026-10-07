import { useEffect } from 'react';
import { useGeolocation } from './device.ts';
import { client, useClient } from './net.ts';
import { Game } from './screens/Game.tsx';
import { Home } from './screens/Home.tsx';
import { Lobby } from './screens/Lobby.tsx';
import { Result } from './screens/Result.tsx';

export function App() {
  const { room, error, offset, connected } = useClient();
  const geo = useGeolocation(!!room && room.phase !== 'finished');

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => client.clearError(), 4000);
    return () => clearTimeout(id);
  }, [error]);

  return (
    <>
      {!room && <Home />}
      {room?.phase === 'lobby' && <Lobby room={room} geo={geo} />}
      {room?.phase === 'playing' && <Game room={room} geo={geo} offset={offset} />}
      {room?.phase === 'finished' && <Result room={room} />}
      {room && !connected && <div className="toast warn">再接続中…</div>}
      {error && <div className="toast" onClick={() => client.clearError()}>{error}</div>}
    </>
  );
}
