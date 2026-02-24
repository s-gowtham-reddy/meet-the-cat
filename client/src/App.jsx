import { useState, useEffect, useRef, useMemo } from 'react'
import io from 'socket.io-client'
import { DotLottieReact } from '@lottiefiles/dotlottie-react'
import './index.css'

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';
const AVATAR_SEEDS = ['Felix', 'Whiskers', 'Garfield', 'Tom', 'Luna', 'Mittens', 'Simba', 'Nala'];

// Cat-themed sticker set using stable cataas.com GIF IDs to ensure synchronization
const STICKER_LIST = [
  'https://cataas.com/cat/1ozkXaGbz1CriQiG',
  'https://cataas.com/cat/1RFXsaXoyCZdplFx',
  'https://cataas.com/cat/1ZfGU7z1uIdnehgj',
  'https://cataas.com/cat/2T7yPn3J5qz54Ygy',
  'https://cataas.com/cat/2tKejk7oauPg3Yt4',
  'https://cataas.com/cat/38lyiUi0Hv9MzKwW',
  'https://cataas.com/cat/3mEJCz1Oj7l1E2tm',
  'https://cataas.com/cat/3prWPtfRjrBXs9M7',
  'https://cataas.com/cat/3Z6CcYkHotdUXQC9',
  'https://cataas.com/cat/48xLBZGSXgxZRMAB',
  'https://cataas.com/cat/5a3YH3bjZJWlsZ95',
  'https://cataas.com/cat/5HiPQ6HEHv1fQwPZ',
];

function App() {
  // Simplified Onboarding State
  const [step, setStep] = useState(0); // 0: Setup Identity, 1: Chat/Waiting
  const [profile, setProfile] = useState(() => ({
    name: '',
    avatarSeed: AVATAR_SEEDS[0],
    gender: 'male',
    userId: localStorage.getItem('cat_user_id') || `user_${Math.random().toString(36).substr(2, 9)}`
  }));
  const [replyingTo, setReplyingTo] = useState(null);
  const [swipeData, setSwipeData] = useState({ id: null, offset: 0 });

  // Ensure userId is saved
  useEffect(() => {
    if (!localStorage.getItem('cat_user_id')) {
      localStorage.setItem('cat_user_id', profile.userId);
    }
  }, [profile.userId]);

  // UI / Global State
  const [, setOnlineCount] = useState(0);
  const [lobbyCount, setLobbyCount] = useState(0);
  const [roomUserCount, setRoomUserCount] = useState(0);
  const [, setIsConnected] = useState(false);
  const [theme, setTheme] = useState('light'); // light, dark, pink
  const [messageSoundOn, setMessageSoundOn] = useState(true);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);
  const [showProfileCard, setShowProfileCard] = useState(false);

  // Chat State
  const [message, setMessage] = useState('');
  const [chat, setChat] = useState([]);
  const [status, setStatus] = useState('idle'); // idle, waiting, connected
  const [partner, setPartner] = useState(null); // { name, avatarSeed }
  const [isPartnerTyping, setIsPartnerTyping] = useState(false);
  const [roomId, setRoomId] = useState(null);
  const [roomName, setRoomName] = useState('');
  const [roomCreator, setRoomCreator] = useState('');
  const [showRoomModal, setShowRoomModal] = useState(false);
  const [modalTab, setModalTab] = useState('create'); // 'create' or 'join'
  const [inputRoomId, setInputRoomId] = useState('');
  const [, setRoomLink] = useState('');
  const [roomJoinError, setRoomJoinError] = useState(null);

  const socketRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const messagesEndRef = useRef(null);
  const messageSoundRef = useRef(null);
  if (!messageSoundRef.current) {
    messageSoundRef.current = new Audio('https://assets.mixkit.co/active_storage/sfx/2560-message-pop-alert.mp3');
  }

  const dragRef = useRef({ startX: 0, msg: null, lastOffset: 0 });
  const swipeCleanupRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [chat, isPartnerTyping]);

  const profileRef = useRef(profile);
  useEffect(() => { profileRef.current = profile; }, [profile]);

  const roomIdRef = useRef(roomId);
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);

  const messageSoundOnRef = useRef(messageSoundOn);
  useEffect(() => { messageSoundOnRef.current = messageSoundOn; }, [messageSoundOn]);

  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  useEffect(() => {
    const socket = io(SOCKET_URL, { reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 1000 });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log("Connected to server");
      setIsConnected(true);
      // Re-join queue or room after reconnect (e.g. server restart or network blip)
      const currentStatus = statusRef.current;
      const currentRoomId = roomIdRef.current;
      const currentProfile = profileRef.current;
      if (currentStatus === 'waiting' && !currentRoomId && currentProfile?.name) {
        socket.emit('join_queue', currentProfile);
      }
      if (currentStatus === 'connected' && currentRoomId && currentProfile?.name) {
        socket.emit('join_private_room', { roomId: currentRoomId, profile: currentProfile });
      }
    });

    socket.on('disconnect', (reason) => {
      setIsConnected(false);
      if (reason === 'io server disconnect') {
        console.warn('Server disconnected the socket');
      }
    });

    socket.on('connect_error', (err) => {
      console.warn('Socket connect_error:', err.message);
    });

    socket.on('error', (err) => {
      console.warn('Socket error:', err);
    });

    socket.on('user_count', (count) => setOnlineCount(count));

    socket.on('chat_start', (data) => {
      setStatus('connected');
      setPartner(data.partner);
      setChat([]);
      setIsPartnerTyping(false);
      setStep(1);
    });

    socket.on('receive_message', (data) => {
      setIsPartnerTyping(false);
      setChat((prev) => [...prev, { ...data, isMe: false }]);
      if (data.sender && !partner) {
        setPartner(data.sender);
      }
      if (data.messageId && data.senderSocketId && !data.isSystem) {
        socketRef.current?.emit('message_delivered', { messageId: data.messageId, senderSocketId: data.senderSocketId });
      }
      if (messageSoundOnRef.current && !data.isSystem) {
        messageSoundRef.current?.play().catch(() => { });
      }
    });

    socket.on('message_delivered', (data) => {
      const { messageId } = data;
      if (messageId) {
        setChat((prev) => prev.map((m) => (m.id === messageId ? { ...m, delivered: true } : m)));
      }
    });


    socket.on('partner_typing', () => setIsPartnerTyping(true));
    socket.on('partner_stop_typing', () => setIsPartnerTyping(false));

    socket.on('partner_disconnected', () => {
      setStatus('waiting');
      setChat([]);
      setPartner(null);
      setIsPartnerTyping(false);
      if (!roomId) {
        socketRef.current?.emit('join_queue', profileRef.current);
      }
    });

    socket.on('room_created', (data) => {
      const url = new URL(window.location.href);
      url.searchParams.set('room', data.roomId);
      setRoomLink(url.toString());
      setRoomId(data.roomId);
      setRoomName(data.roomName);
      setRoomCreator(profileRef.current.name);
      setStatus('waiting');
      setStep(1);
    });

    socket.on('room_joined', (data) => {
      setRoomJoinError(null);
      setRoomId(data.roomId);
      setRoomName(data.roomName);
      setRoomCreator(data.creatorName);
      setStatus('connected'); // Transition to connected immediately upon join
      setStep(1);
    });

    socket.on('partner_joined', (data) => {
      setStatus('connected');
      setPartner(data.partner);
      // Don't clear chat here if it's a join message for an existing room
    });

    socket.on('request_partner_info', () => {
      socketRef.current?.emit('send_partner_info', {
        roomId: roomIdRef.current,
        profile: profileRef.current
      });
    });

    socket.on('room_error', (data) => {
      setRoomJoinError(data.message || 'Room not found or code invalid.');
      setStep(0);
      setShowRoomModal(true);
      setModalTab('join');
    });

    socket.on('lobby_count', (count) => {
      setLobbyCount(count);
    });

    socket.on('room_count', (count) => {
      setRoomUserCount(count);
    });

    socket.on('room_info_preview', (data) => {
      setRoomName(data.roomName);
      setRoomCreator(data.creatorName);
    });

    // Check for room in URL on mount
    const urlParams = new URLSearchParams(window.location.search);
    const roomFromUrl = urlParams.get('room');
    if (roomFromUrl) {
      setRoomId(roomFromUrl);
      socket.emit('get_room_info', { roomId: roomFromUrl });
    }

    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: run once on mount only
  }, []);


  const handleJoinQueue = () => {
    if (step === 0) setStep(1);
    setStatus('waiting');
    setChat([]);
    setPartner(null);
    setRoomId(null);
    socketRef.current?.emit('register_cat', { userId: profile.userId, profile });
    socketRef.current?.emit('join_queue', profile);
  };

  const handleCreateRoom = (e) => {
    if (e) e.preventDefault();
    if (roomName.trim() && profile.name.trim()) {
      socketRef.current?.emit('register_cat', { userId: profile.userId, profile });
      socketRef.current?.emit('create_room', { roomName, profile });
      setStep(1);
      setStatus('waiting');
      setShowRoomModal(false);
    }
  };

  const handleJoinRoom = (e) => {
    if (e) e.preventDefault();
    if (inputRoomId.trim() && profile.name.trim()) {
      setRoomJoinError(null);
      socketRef.current?.emit('register_cat', { userId: profile.userId, profile });
      socketRef.current?.emit('join_private_room', { roomId: inputRoomId.trim(), profile });
      setStep(1);
      setStatus('waiting');
      setShowRoomModal(false);
    }
  };

  const handleStartChat = () => {
    if (profile.name.trim() && profile.gender) {
      if (roomId) {
        socketRef.current?.emit('join_private_room', { roomId, profile });
        setStep(1);
        setStatus('waiting');
      } else {
        socketRef.current?.emit('join_queue', profile);
        // Otherwise, join the public queue
        handleJoinQueue();
      }
    }
  };

  const [copyFeedback, setCopyFeedback] = useState(false);
  const copyRoomCode = () => {
    if (roomId) {
      navigator.clipboard.writeText(roomId).then(() => {
        setCopyFeedback(true);
        setTimeout(() => setCopyFeedback(false), 2000);
      }).catch(() => { });
    }
  };


  const handleTyping = () => {
    socketRef.current?.emit('typing', { roomId });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socketRef.current?.emit('stop_typing', { roomId });
    }, 1000);
  };

  const SWIPE_THRESHOLD = 60;
  const SWIPE_MAX_OFFSET = 120;

  const applySwipeMove = (clientX) => {
    const drag = dragRef.current;
    if (!drag?.msg) return;
    const diff = Math.max(-SWIPE_MAX_OFFSET, Math.min(SWIPE_MAX_OFFSET, clientX - drag.startX));
    drag.lastOffset = diff;
    setSwipeData(prev => (prev.id !== null ? { ...prev, offset: diff } : prev));
  };

  const handleSwipeMove = (e) => {
    const clientX = e.touches ? e.touches[0]?.clientX : e.clientX;
    if (clientX == null) return;
    applySwipeMove(clientX);
  };

  const handleSwipeEnd = (msgParam) => {
    const msg = msgParam ?? dragRef.current?.msg;
    const lastOffset = dragRef.current?.lastOffset ?? 0;
    if (msg && Math.abs(lastOffset) >= SWIPE_THRESHOLD) {
      setReplyingTo({
        text: msg.message,
        name: msg.isMe ? 'You' : (msg.sender?.name || partner?.name || 'Stranger'),
        userId: msg.userId
      });
      if (window.navigator.vibrate) window.navigator.vibrate(10);
    }
    swipeCleanupRef.current?.();
    swipeCleanupRef.current = null;
    dragRef.current = { startX: 0, msg: null, lastOffset: 0 };
    setSwipeData({ id: null, offset: 0 });
  };

  const handleSwipeStart = (e, msgId, msg) => {
    const touch = e.touches ? e.touches[0] : e;
    const startX = touch?.clientX ?? 0;
    dragRef.current = { startX, msg, lastOffset: 0 };
    setSwipeData({ id: msgId, startX, offset: 0 });

    if (e.type === 'mousedown') {
      const onDocMouseMove = (ev) => handleSwipeMove(ev);
      const onDocMouseUp = () => handleSwipeEnd();
      document.addEventListener('mousemove', onDocMouseMove);
      document.addEventListener('mouseup', onDocMouseUp);
      swipeCleanupRef.current = () => {
        document.removeEventListener('mousemove', onDocMouseMove);
        document.removeEventListener('mouseup', onDocMouseUp);
      };
      return;
    }

    if (e.type === 'touchstart') {
      const onDocTouchMove = (ev) => {
        if (dragRef.current?.msg && ev.cancelable) {
          ev.preventDefault();
          const t = ev.touches[0];
          if (t) applySwipeMove(t.clientX);
        }
      };
      const onDocTouchEnd = () => handleSwipeEnd();
      document.addEventListener('touchmove', onDocTouchMove, { passive: false });
      document.addEventListener('touchend', onDocTouchEnd, { passive: true });
      swipeCleanupRef.current = () => {
        document.removeEventListener('touchmove', onDocTouchMove);
        document.removeEventListener('touchend', onDocTouchEnd);
      };
    }
  };

  const getMessageSummary = (text) => {
    if (!text) return '';
    if (text.startsWith('[sticker:')) return '🐾 Sticker';
    return text;
  };

  const performSend = (textOverride) => {
    const textToSend = textOverride !== undefined ? textOverride : message;
    if (!textToSend.trim() || status !== 'connected' || !socketRef.current?.connected) return;

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const timestamp = new Date().toISOString();

    const msgData = {
      message: textToSend,
      isMe: true,
      timestamp,
      userId: profile.userId,
      replyTo: replyingTo,
      id: messageId
    };

    socketRef.current?.emit('send_message', {
      message: textToSend,
      roomId,
      profile,
      replyTo: replyingTo,
      messageId
    });

    socketRef.current?.emit('stop_typing', { roomId });
    setChat((prev) => [...prev, msgData]);
    if (textOverride === undefined) setMessage('');
    setReplyingTo(null);
  };

  const sendMessage = (e) => {
    e.preventDefault();
    performSend();
  };

  const handleLeaveRoom = () => {
    if (window.confirm('Are you sure you want to leave this Cat Pack? 🐾🚪')) {
      handleHome();
    }
  };

  const handleSkip = () => {
    socketRef.current?.emit('skip_chat');
    handleJoinQueue(); // Rejoin queue after skipping
  };

  const handleHome = () => {
    if (status === 'connected' || status === 'waiting') {
      socketRef.current?.emit('skip_chat');
    }
    setStep(0);
    setStatus('idle');
    setChat([]);
    setPartner(null);
    setIsPartnerTyping(false);
    setRoomId(null);
    setRoomLink('');
    // Clear URL params
    window.history.pushState({}, '', window.location.pathname);
  };

  // Real cat photos via cataas.com — consistent per seed, no API key required
  const getCatUrl = (seed) => `https://cataas.com/cat?seed=${encodeURIComponent(seed || 'default')}&width=200&height=200`;

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    try {
      const date = new Date(timestamp);
      // Fallback for cases where timestamp might already be formatted (legacy or edge cases)
      if (isNaN(date.getTime())) return timestamp;
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return timestamp;
    }
  };

  const toggleTheme = () => {
    const themes = ['light', 'dark', 'pink'];
    const nextIndex = (themes.indexOf(theme) + 1) % themes.length;
    setTheme(themes[nextIndex]);
  };

  return (
    <div className={`app-wrapper theme-${theme}`}>
      <div className="app-main-container">
        <header className="app-header">
          <div className="brand" onClick={handleHome} title="Return to Home">
            <h1>Meet The Cat</h1>
          </div>
          <div className="header-status">
            {roomId && (
              <div className="status-item room-code-wrap">
                <div className="room-code-pill" onClick={copyRoomCode} title="Click to copy">
                  <span className="count-label">Room Code:</span>
                  <span className="count-value code-accent">{roomId}</span>
                </div>
              </div>
            )}
            <div className="status-item online-cats-pill">
              <img src={getCatUrl('online_count')} className="online-cat-icon" alt="" />
              <div className="online-cats-text">
                <span className="count-label">{roomId ? 'Cats in Room:' : 'Online Cats:'}</span>
                <span className="count-value">{roomId ? roomUserCount : lobbyCount}</span>
              </div>
            </div>
            <div className="header-actions">
              <button onClick={toggleTheme} className="theme-toggle-btn" title="Change Theme">
                <span className="cat-icon-theme">✨😺</span>
              </button>
            </div>
          </div>
        </header>

        <main className="content-area">
          {step === 0 && (
            <div className="landing-page-scroll-container">
              <section className="identity-section" id="home">
                <div className="identity-screen">
                  <div className="identity-header">
                    <h2>Set Your Identity</h2>
                    <p>One step away from meeting someone new!</p>
                  </div>

                  <div className="identity-layout">
                    <div className="identity-left">
                      <div className="input-group">
                        <label>What's your name?</label>
                        <input
                          type="text"
                          placeholder="e.g. Kitty"
                          value={profile.name}
                          onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                          className="name-input-modern"
                        />
                      </div>

                      <div className="input-group">
                        <label>I am a...</label>
                        <div className="gender-choices">
                          <div
                            className={`gender-card ${profile.gender === 'male' ? 'active' : ''}`}
                            onClick={() => setProfile({ ...profile, gender: 'male' })}
                          >
                            <div className="gender-avatar">🐈‍⬛</div>
                            <span>Gentleman</span>
                          </div>
                          <div
                            className={`gender-card ${profile.gender === 'female' ? 'active' : ''}`}
                            onClick={() => setProfile({ ...profile, gender: 'female' })}
                          >
                            <div className="gender-avatar">🐈</div>
                            <span>Lady</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="identity-right">
                      <label>Choose your cat avatar</label>
                      <div className="avatar-grid-modern">
                        {AVATAR_SEEDS.map(seed => (
                          <div
                            key={seed}
                            className={`avatar-item ${profile.avatarSeed === seed ? 'selected' : ''}`}
                            onClick={() => setProfile({ ...profile, avatarSeed: seed })}
                          >
                            <img src={getCatUrl(seed)} alt={seed} />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="identity-footer">
                    <div className="main-actions">
                      <button
                        className="primary-btn pulse-btn"
                        onClick={handleStartChat}
                        disabled={!profile.name.trim() || !profile.gender}
                      >
                        {roomId ? 'Join Private Room 🐾' : 'Start Meeting Cats 🐾'}
                      </button>
                      <button
                        className="secondary-btn create-room-btn pulse-btn"
                        onClick={() => {
                          setShowRoomModal(true);
                        }}
                        disabled={!!roomId}
                        title="Create or Join Private Chat Room"
                      >
                        <img src={getCatUrl('room-btn')} className="room-btn-img" alt="Cat Room" />
                      </button>
                    </div>
                    <div className="scroll-hint">
                      <p>Scroll down to learn more</p>
                      <div className="arrow-down">↓</div>
                    </div>
                  </div>

                  {showRoomModal && (
                    <div className="modal-overlay">
                      <div className="modal-content glass-card room-modal">
                        <div className="modal-tabs">
                          <button
                            className={`tab-btn ${modalTab === 'create' ? 'active' : ''}`}
                            onClick={() => setModalTab('create')}
                          >
                            Create Room
                          </button>
                          <button
                            className={`tab-btn ${modalTab === 'join' ? 'active' : ''}`}
                            onClick={() => setModalTab('join')}
                          >
                            Join Room
                          </button>
                        </div>

                        {modalTab === 'create' ? (
                          <div className="tab-pane">
                            <form onSubmit={handleCreateRoom}>
                              <div className="modal-input-group">
                                <input
                                  type="text"
                                  placeholder="Your Name"
                                  value={profile.name}
                                  onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                                  required
                                />
                              </div>
                              <div className="modal-input-group">
                                <input
                                  type="text"
                                  placeholder="Room Name ..."
                                  value={roomName}
                                  onChange={(e) => setRoomName(e.target.value)}
                                  required
                                />
                              </div>
                              <div className="modal-buttons">
                                <button type="button" className="cancel-btn" onClick={() => setShowRoomModal(false)}>Cancel</button>
                                <button type="submit" className="confirm-btn">Create 🐾</button>
                              </div>
                            </form>
                          </div>
                        ) : (
                          <div className="tab-pane">
                            {roomJoinError && (
                              <div className="room-join-error" role="alert">
                                {roomJoinError}
                              </div>
                            )}
                            <form onSubmit={handleJoinRoom}>
                              <div className="modal-input-group">
                                <input
                                  type="text"
                                  placeholder="Your Name"
                                  value={profile.name}
                                  onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                                  required
                                />
                              </div>
                              <div className="modal-input-group">
                                <input
                                  type="text"
                                  placeholder="Secret Room Code..."
                                  value={inputRoomId}
                                  onChange={(e) => {
                                    setInputRoomId(e.target.value);
                                    setRoomJoinError(null);
                                  }}
                                  required
                                />
                              </div>
                              <div className="modal-buttons">
                                <button type="button" className="cancel-btn" onClick={() => setShowRoomModal(false)}>Cancel</button>
                                <button type="submit" className="confirm-btn">Join 🐾</button>
                              </div>
                            </form>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </section>

              <section className="features-section" id="features">
                <h3 className="section-title">Why Meet The Cat?</h3>
                <div className="features-grid">
                  <div className="feature-card glass-card">
                    <div className="feature-icon">✨</div>
                    <h4>Instant Pairing</h4>
                    <p>No waiting around. Get matched with another online cats in seconds. Just one click and you're chatting!</p>
                  </div>
                  <div className="feature-card glass-card">
                    <div className="feature-icon">🐱</div>
                    <h4>Cat Personas</h4>
                    <p>Express yourself with unique cat avatars and gentleman/lady personas. Be your best feline self.</p>
                  </div>
                  <div className="feature-card glass-card">
                    <div className="feature-icon">🛡️</div>
                    <h4>Safe Space</h4>
                    <p>We prioritize a respectful community. Use the 'Next Cat' button anytime if a conversation doesn't feel right.</p>
                  </div>
                </div>
              </section>

              <section className="rules-section" id="rules">
                <div className="rules-container glass-card">
                  <h3 className="section-title">Community Rules</h3>
                  <div className="rules-content">
                    <div className="rule-item">
                      <span className="rule-bullet">🔞</span>
                      <p><strong>18+ Only:</strong> By using this website, you agree that you are at least 18 years of age.</p>
                    </div>
                    <div className="rule-item">
                      <span className="rule-bullet">🤝</span>
                      <p><strong>Be Respectful:</strong> No harassment, hate speech, or inappropriate content. Treat every cat with kindness.</p>
                    </div>
                    <div className="rule-item">
                      <span className="rule-bullet">🔒</span>
                      <p><strong>Stay Private:</strong> Don't share personal information like your real name, address, or phone number.</p>
                    </div>
                    <div className="rule-item">
                      <span className="rule-bullet">🚫</span>
                      <p><strong>No Spam:</strong> Avoid sending repetitive messages or advertisements.</p>
                    </div>
                  </div>
                </div>
              </section>

              <footer className="landing-footer">
                <div className="footer-links">
                  <a href="#home" onClick={(e) => { e.preventDefault(); document.getElementById('home').scrollIntoView({ behavior: 'smooth' }); }}>Home</a>
                  <a href="#features" onClick={(e) => { e.preventDefault(); document.getElementById('features').scrollIntoView({ behavior: 'smooth' }); }}>Features</a>
                  <a href="#rules" onClick={(e) => { e.preventDefault(); document.getElementById('rules').scrollIntoView({ behavior: 'smooth' }); }}>Safety</a>
                </div>
                <p className="copyright">© 2026 Meet The Cat. All rights reserved. Purring since 2026.</p>
              </footer>
            </div>
          )}

          {step === 1 && (
            <>
              {status === 'waiting' && !roomId ? (
                <div className="searching-screen">
                  {/* Floating Elements for Aesthetic */}
                  <div className="floating-element float-1">🧶</div>
                  <div className="floating-element float-2">🐾</div>
                  <div className="floating-element float-3">🐱</div>
                  <div className="floating-element float-4">✨</div>

                  <div className="searching-card">
                    <div className="searching-avatar-wrap">
                      <div className="avatar-ring"></div>
                      <img src={getCatUrl(profile.avatarSeed)} className="searching-avatar" alt="My Cat" />
                    </div>

                    <h2 className="searching-title">Finding your purr-fect match</h2>
                    <p className="searching-sub">Searching for a chat partner for <strong>{profile.name}</strong>...</p>

                    <div className="matching-tags">
                      <span className="tag-pill">#Playful</span>
                      <span className="tag-pill">#NightOwl</span>
                    </div>

                    <div className="progress-container">
                      <div className="progress-bar-fill"></div>
                    </div>

                    <p className="estimated-wait">Estimated wait: &lt; 30s</p>

                    <button className="cancel-match-btn" onClick={handleHome}>
                      ✕ Cancel Search
                    </button>
                  </div>

                  <div className="online-counter-badge">
                    🐾 {lobbyCount} Cats Online Now
                  </div>
                </div>
              ) : (
                <div className={`chat-layout-wrapper ${status === 'connected' ? 'wide-layout' : 'centered-layout'}`}>
                  <div className="chat-container">
                    <div className="chat-sub-header">
                      <div className="chat-info">
                        {status === 'waiting' ? (
                          <div className="waiting-info">
                            <p className="waiting-text">{roomId ? `Waiting for friends in ${roomName || 'Private Room'}...` : `Searching for a match for ${profile.name}...`}</p>
                            {roomId && (
                              <div className="room-code-display-wrap">
                                <div className="room-code-display" onClick={copyRoomCode} title="Click to copy">
                                  <span className="code-label">CODE:</span>
                                  <span className="code-value">{roomId}</span>
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="partner-info" onClick={() => setShowProfileCard(true)} title="View partner profile">
                            <img src={getCatUrl(partner?.avatarSeed)} className="partner-mini-avatar" alt="" />
                            <p>
                              {roomId ? (
                                <>Private Room - <strong>{roomName || 'Cat Pack'}</strong></>
                              ) : (
                                <>Chatting with <strong>{partner?.name || 'Stranger'}</strong></>
                              )}
                            </p>
                            {/* 3-dot menu — only in private rooms */}
                            {roomId && (
                              <div className="partner-options-wrap">
                                <button
                                  className="partner-options-btn"
                                  onClick={() => setShowOptionsMenu((v) => !v)}
                                  title="More options"
                                >
                                  <span>⋮</span>
                                </button>
                                {showOptionsMenu && (
                                  <div className="partner-options-dropdown">
                                    <button onClick={() => { copyRoomCode(); setShowOptionsMenu(false); }}>
                                      📋 Copy Room Code
                                    </button>
                                    <button className="options-report" onClick={() => { alert('Report feature coming soon 🐾'); setShowOptionsMenu(false); }}>
                                      🚨 Report
                                    </button>
                                    <button className="options-leave" onClick={() => { setShowOptionsMenu(false); handleLeaveRoom(); }}>
                                      🚪 Leave Room
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {status === 'connected' ? (
                      <>
                        <div className="messages-box">
                          {chat.map((msg, index) => (
                            msg.isSystem ? (
                              <div key={index} className="system-message">
                                <p>{msg.message}</p>
                              </div>
                            ) : (
                              <div
                                key={index}
                                className={`message-row ${msg.isMe ? 'my-row' : 'stranger-row'} ${swipeData.id === index ? 'swiping-active' : ''} ${swipeData.id === index && swipeData.offset >= 0 ? 'swipe-direction-right' : ''} ${swipeData.id === index && swipeData.offset < 0 ? 'swipe-direction-left' : ''}`}
                                style={{
                                  transform: swipeData.id === index ? `translateX(${swipeData.offset}px)` : 'none'
                                }}
                                title="Swipe or drag left/right to reply"
                                onTouchStart={(e) => handleSwipeStart(e, index, msg)}
                                onTouchMove={handleSwipeMove}
                                onTouchEnd={() => handleSwipeEnd(msg)}
                                onMouseDown={(e) => handleSwipeStart(e, index, msg)}
                                onMouseMove={handleSwipeMove}
                                onMouseUp={() => handleSwipeEnd(msg)}
                              >
                                <div className="swipe-indicator swipe-indicator-left" aria-hidden>🐾 Reply</div>
                                <div className="swipe-indicator swipe-indicator-right" aria-hidden>Reply 🐾</div>
                                <div className="avatar">
                                  <img src={getCatUrl(msg.isMe ? profile.avatarSeed : (msg.sender?.avatarSeed || partner?.avatarSeed))} alt="p" />
                                </div>
                                <div className={`message-bubble ${msg.isMe ? 'my-message' : 'stranger-message'}`}>
                                  {!msg.isMe && (roomId || msg.sender) && (
                                    <div className="sender-name">{msg.sender?.name || partner?.name || 'Stranger'}</div>
                                  )}

                                  {msg.replyTo && (
                                    <div className="quoted-message">
                                      <span className="quoted-name">{msg.replyTo.name}</span>
                                      <div className="quoted-text">{getMessageSummary(msg.replyTo.text)}</div>
                                    </div>
                                  )}

                                  <div className="message-text">
                                    {msg.message?.startsWith('[sticker:') ? (
                                      <img
                                        src={msg.message.slice(9, -1)}
                                        alt="Cat sticker"
                                        className="chat-sticker-img"
                                        loading="lazy"
                                      />
                                    ) : msg.message}
                                  </div>
                                  <div className="message-meta-row">
                                    <span className="message-time">{formatTime(msg.timestamp)}</span>
                                    {msg.isMe && msg.delivered && <span className="message-receipt" title="Delivered">✓</span>}
                                  </div>
                                </div>
                              </div>
                            )
                          ))}
                          {isPartnerTyping && (
                            <div className="typing-indicator">
                              <span className="typing-paw">🐾</span>
                              <span>{partner?.name || 'Someone'} is typing...</span>
                            </div>
                          )}
                          <div ref={messagesEndRef} />
                        </div>

                        <div className="chat-controls-area">
                          {replyingTo && (
                            <div className="reply-preview-container">
                              <div className="reply-preview-content">
                                <span className="reply-preview-name">Replying to {replyingTo.name}</span>
                                <div className="reply-preview-text">{getMessageSummary(replyingTo.text)}</div>
                              </div>
                              <button className="cancel-reply-btn" onClick={() => setReplyingTo(null)}>✕</button>
                            </div>
                          )}
                          {status === 'connected' && !roomId && (
                            <div className="next-cat-container">
                              <button className="next-cat-btn-glass" onClick={handleSkip}>
                                Next Cat 🐾
                              </button>
                            </div>
                          )}
                          {showStickerPicker && (
                            <div className="sticker-picker-panel">
                              <div className="sticker-picker-header">
                                <span>🐾 Cat Stickers</span>
                                <button type="button" className="sticker-picker-close" onClick={() => setShowStickerPicker(false)}>✕</button>
                              </div>
                              <div className="sticker-grid">
                                {STICKER_LIST.map((url, i) => (
                                  <button
                                    key={i}
                                    type="button"
                                    className="sticker-item"
                                    onClick={() => {
                                      performSend(`[sticker:${url}]`);
                                      setShowStickerPicker(false);
                                    }}
                                  >
                                    <img src={url} alt={`Cat sticker ${i + 1}`} loading="lazy" />
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          <form className="input-area" onSubmit={sendMessage}>
                            <input
                              type="text"
                              placeholder="Type a message..."
                              value={message}
                              onChange={(e) => {
                                setMessage(e.target.value);
                                handleTyping();
                              }}
                            />
                            <button type="button" className="sticker-trigger-btn" onClick={() => setShowStickerPicker((v) => !v)} title="Send a cat sticker">
                              🎨
                            </button>
                            <button type="submit" className="send-btn"><span className="send-icon">🐾</span></button>
                            {roomId && (
                              <button type="button" className="exit-room-btn" onClick={handleLeaveRoom} title="Leave Room">
                                <svg className="exit-door-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M13 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7" />
                                  <polyline points="17 8 21 12 17 16" />
                                  <line x1="21" y1="12" x2="9" y2="12" />
                                </svg>
                              </button>
                            )}
                          </form>
                        </div>
                      </>
                    ) : (
                      <div className="waiting-screen">
                        <div className="lottie-container">
                          <DotLottieReact
                            src="https://lottie.host/66c26512-b761-4419-82d7-07d8f285a60a/OYJBZAfJEY.lottie"
                            loop autoplay
                          />
                        </div>
                        <p className="animated-waiting">
                          {roomId ? (
                            roomCreator === profile.name
                              ? `Waiting for friends in ${roomName || 'your room'}...`
                              : `Letting in to ${roomCreator || 'the'}'s room`
                          ) : 'Finding your pair...'}
                        </p>
                        {/* 3-dot menu — only in private rooms */}
                        {roomId && (
                          <div className="partner-options-wrap">
                            <button
                              className="partner-options-btn"
                              onClick={() => setShowOptionsMenu((v) => !v)}
                              title="More options"
                            >
                              <span>⋮</span>
                            </button>
                            {showOptionsMenu && (
                              <div className="partner-options-dropdown">
                                <button onClick={() => { copyRoomCode(); setShowOptionsMenu(false); }}>
                                  📋 Copy Room Code
                                </button>
                                <button className="options-report" onClick={() => { alert('Report feature coming soon 🐾'); setShowOptionsMenu(false); }}>
                                  🚨 Report
                                </button>
                                <button className="options-leave" onClick={() => { setShowOptionsMenu(false); handleLeaveRoom(); }}>
                                  🚪 Leave Room
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </main>

        {showProfileCard && partner && (
          <div className="modal-overlay profile-modal-overlay" onClick={() => setShowProfileCard(false)}>
            <div className="modal-content profile-card-modal glass-card" onClick={(e) => e.stopPropagation()}>
              <button className="modal-close-btn" onClick={() => setShowProfileCard(false)}>✕</button>

              <div className="profile-cat-hero">
                <img src={getCatUrl(partner.avatarSeed)} alt={partner.name} className="profile-hero-img" />
                <div className="paw-ring-overlay">🐾</div>
                <div className="online-dot-big"></div>
              </div>

              <div className="profile-info-main">
                <h2 className="profile-name-big">{partner.name} <span className="verified-check">✓</span></h2>
                <p className="profile-bio-italic">"Just a curious cat looking for a purr-fect conversation."</p>

                <div className="profile-stats-row">
                  <div className="stat-item">
                    <span className="stat-value">1.2k</span>
                    <span className="stat-label">Messages</span>
                  </div>
                  <div className="stat-divider"></div>
                  <div className="stat-item">
                    <span className="stat-value">84</span>
                    <span className="stat-label">Matches</span>
                  </div>
                  <div className="stat-divider"></div>
                  <div className="stat-item">
                    <span className="stat-value">4.9</span>
                    <span className="stat-label">Rating</span>
                  </div>
                </div>

                <div className="profile-tags-cloud">
                  <span className="profile-tag-pill">#Friendly</span>
                  <span className="profile-tag-pill">#Playful</span>
                  <span className="profile-tag-pill">#GentleHeart</span>
                </div>

                <div className="profile-actions-grid">
                  <button className="profile-cta-btn primary-btn" onClick={() => setShowProfileCard(false)}>
                    Close 🐾
                  </button>
                  <div className="secondary-actions-row">
                    <button className="profile-ghost-btn" onClick={() => alert('Future feature: View Secret Identity 🕵️')}>
                      View Secret Identity
                    </button>
                    <button className="profile-ghost-btn danger-text" onClick={() => { alert('Report feature coming soon 🐾'); setShowProfileCard(false); }}>
                      Report
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default App
