import { useState, useEffect, useRef } from 'react'
import io from 'socket.io-client'
import { DotLottieReact } from '@lottiefiles/dotlottie-react'
import './index.css'

const SOCKET_URL = 'http://localhost:3001';
const AVATAR_SEEDS = ['Felix', 'Whiskers', 'Garfield', 'Tom', 'Luna', 'Mittens', 'Simba', 'Nala'];

function App() {
  // Simplified Onboarding State
  const [step, setStep] = useState(0); // 0: Setup Identity, 1: Chat/Waiting
  const [profile, setProfile] = useState({
    name: '',
    avatarSeed: AVATAR_SEEDS[0],
    gender: 'male'
  });

  // UI / Global State
  const [onlineCount, setOnlineCount] = useState(0);
  const [theme, setTheme] = useState('light'); // light, dark, pink
  const [isMuted, setIsMuted] = useState(false);

  // Chat State
  const [message, setMessage] = useState('');
  const [chat, setChat] = useState([]);
  const [status, setStatus] = useState('idle'); // idle, waiting, connected
  const [partner, setPartner] = useState(null); // { name, avatarSeed }
  const [isPartnerTyping, setIsPartnerTyping] = useState(false);
  const [showMeowAnim, setShowMeowAnim] = useState(false);

  const socketRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const messagesEndRef = useRef(null);
  const meowAudioRef = useRef(new Audio('https://www.myinstants.com/media/sounds/meow_1.mp3'));

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [chat, isPartnerTyping]);

  const profileRef = useRef(profile);
  useEffect(() => { profileRef.current = profile; }, [profile]);

  useEffect(() => {
    socketRef.current = io(SOCKET_URL);

    socketRef.current.on('connect', () => console.log("Connected to server"));
    socketRef.current.on('user_count', (count) => setOnlineCount(count));

    socketRef.current.on('chat_start', (data) => {
      setStatus('connected');
      setPartner(data.partner);
      setChat([]);
      setIsPartnerTyping(false);
      setStep(1);
    });

    socketRef.current.on('receive_message', (data) => {
      setIsPartnerTyping(false);
      setChat((prev) => [...prev, { ...data, isMe: false }]);
    });

    socketRef.current.on('partner_meow', () => {
      triggerMeowStorm();
      if (!isMuted) meowAudioRef.current.play().catch(() => { });
    });

    socketRef.current.on('partner_typing', () => setIsPartnerTyping(true));
    socketRef.current.on('partner_stop_typing', () => setIsPartnerTyping(false));

    socketRef.current.on('partner_disconnected', () => {
      setStatus('waiting');
      setChat([]);
      setPartner(null);
      setIsPartnerTyping(false);
      socketRef.current.emit('join_queue', profileRef.current);
    });

    return () => socketRef.current.disconnect();
  }, []); // Only run once on mount!

  useEffect(() => {
    // Handling mute status separately if needed, but better to check isMuted in listeners directly
    // or use a ref for isMuted too.
  }, [isMuted]);

  const handleStartChat = () => {
    if (profile.name.trim() && profile.gender) {
      socketRef.current.emit('join_queue', profile);
      setStep(1);
      setStatus('waiting');
    }
  };

  const triggerMeowStorm = () => {
    setShowMeowAnim(true);
    setTimeout(() => setShowMeowAnim(false), 2500);
  };

  const handleMeow = () => {
    socketRef.current.emit('meow');
    triggerMeowStorm();
    if (!isMuted) meowAudioRef.current.play().catch(() => { });
  };

  const handleTyping = () => {
    socketRef.current.emit('typing');
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socketRef.current.emit('stop_typing');
    }, 1000);
  };

  const sendMessage = (e) => {
    e.preventDefault();
    if (message.trim() && status === 'connected') {
      const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const msgData = { message, isMe: true, timestamp };

      socketRef.current.emit('send_message', { message });
      socketRef.current.emit('stop_typing');
      setChat((prev) => [...prev, msgData]);
      setMessage('');
    }
  };

  const handleSkip = () => {
    socketRef.current.emit('skip_chat');
    setStatus('waiting');
    setChat([]);
    setPartner(null);
    setIsPartnerTyping(false);
    socketRef.current.emit('join_queue', profile);
  };

  const handleHome = () => {
    if (status === 'connected' || status === 'waiting') {
      socketRef.current.emit('skip_chat');
    }
    setStep(0);
    setStatus('idle');
    setChat([]);
    setPartner(null);
    setIsPartnerTyping(false);
  };

  const getCatUrl = (seed) => `https://robohash.org/${seed}.png?set=set4&size=400x400`;

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
            <div className="status-item online-cats-pill">
              <img src="https://robohash.org/white-brown-cat.png?set=set4&size=200x200" className="online-cat-icon" alt="" />
              <div className="online-cats-text">
                <span className="count-label">Online Cats:</span>
                <span className="count-value">{onlineCount}</span>
              </div>
            </div>
            <div className="header-actions">
              <button onClick={toggleTheme} className="theme-toggle-btn" title="Change Theme">
                <span className="cat-icon-theme">✨😺</span>
              </button>
              <button onClick={() => setIsMuted(!isMuted)} className="mute-toggle-btn" title="Toggle Sound">
                {isMuted ? '🔕' : '🔔'}
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
                    <button
                      className="primary-btn pulse-btn"
                      onClick={handleStartChat}
                      disabled={!profile.name.trim() || !profile.gender}
                    >
                      Start Meeting Cats 🐾
                    </button>
                    <div className="scroll-hint">
                      <p>Scroll down to learn more</p>
                      <div className="arrow-down">↓</div>
                    </div>
                  </div>
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
            <div className={`chat-layout-wrapper ${status === 'connected' ? 'wide-layout' : 'centered-layout'}`}>
              <div className="chat-container">
                <div className="chat-sub-header">
                  <div className="chat-info">
                    {status === 'waiting' ? (
                      <p className="waiting-text">Searching for a match for {profile.name}...</p>
                    ) : (
                      <div className="partner-info">
                        <img src={getCatUrl(partner?.avatarSeed)} className="partner-mini-avatar" alt="" />
                        <p>Chatting with <strong>{partner?.name}</strong></p>
                      </div>
                    )}
                  </div>
                </div>

                {status === 'connected' ? (
                  <>
                    <div className="messages-box">
                      {chat.map((msg, index) => (
                        <div key={index} className={`message-row ${msg.isMe ? 'my-row' : 'stranger-row'}`}>
                          <div className="avatar">
                            <img src={getCatUrl(msg.isMe ? profile.avatarSeed : partner.avatarSeed)} alt="p" />
                          </div>
                          <div className={`message-bubble ${msg.isMe ? 'my-message' : 'stranger-message'}`}>
                            <div className="message-text">{msg.message}</div>
                            <div className="message-time">{msg.timestamp}</div>
                          </div>
                        </div>
                      ))}
                      {isPartnerTyping && (
                        <div className="typing-indicator">
                          <span className="typing-paw">🐾</span>
                          <span>{partner?.name || 'Stranger'} is typing...</span>
                        </div>
                      )}
                      <div ref={messagesEndRef} />
                    </div>

                    <div className="chat-controls-area">
                      {status === 'connected' && (
                        <div className="next-cat-container">
                          <button className="next-cat-btn-glass" onClick={handleSkip}>
                            Next Cat 🐾
                          </button>
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
                        <button type="button" className="meow-btn" onClick={handleMeow} title="Send a Meow!">
                          <img src="https://robohash.org/premium-meow.png?set=set4&size=100x100" alt="Meow" />
                        </button>
                        <button type="submit" className="send-btn"><span className="send-icon">🐾</span></button>
                      </form>
                      {showMeowAnim && (
                        <div className="meow-storm-overlay">
                          {[...Array(15)].map((_, i) => (
                            <div key={i} className="storm-item" style={{
                              left: `${Math.random() * 100}%`,
                              animationDelay: `${Math.random() * 0.5}s`,
                              fontSize: `${1 + Math.random() * 2}rem`
                            }}>
                              {['MEOW! 🐾', '🐾', '🐱', '🐱‍👤', '✨'][Math.floor(Math.random() * 5)]}
                            </div>
                          ))}
                        </div>
                      )}
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
                    <p className="animated-waiting">Finding your pair...</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

export default App
