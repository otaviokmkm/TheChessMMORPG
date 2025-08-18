# Changelog

All notable changes to Tickwars Online will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2025-01-16

### Added
- Enhanced inventory system with visual item display and grid layout
- Equipment panel for managing player gear (helmet, armor, weapon, boots)
- Skill tree system for character progression and upgrades
- Achievement system with unlock rewards and progress tracking
- Changelog viewer accessible from main game HUD
- Advanced UI panels that are draggable and save position
- Floating damage/reward numbers for better feedback
- Sound effects for resource gathering and combat rewards
- Help tutorial system for new players

### Improved  
- Enhanced login UI with magical particle effects and better animations
- Login UI now properly disappears after successful authentication
- Panel system with better organization and keyboard shortcuts
- User experience with persistent panel positions
- Visual feedback for player actions and rewards

### Fixed
- Login screen hiding properly after authentication
- Panel dragging and positioning system
- Resource gathering visual feedback
- XP system calculation and display

## [1.1.0] - 2024-12-15

### Added
- Mage character class with fireball spell casting system
- Resource gathering mechanics for trees (wood) and rocks (stone)
- Monster combat system with XP and gold rewards
- Turn-based combat with 2-second tick system
- Real-time spell targeting with range indicators
- Player progression system with levels and experience

### Improved
- Enhanced graphics rendering with better tile system
- Smooth camera following player movement
- Combat animations and visual effects
- Server-client synchronization for spell casting

### Fixed
- Various gameplay balance improvements
- Network synchronization issues
- Combat timing and spell accuracy

## [1.0.0] - 2024-11-20

### Added
- Server-authoritative multiplayer architecture using FastAPI and WebSockets
- User authentication and registration system with JWT tokens
- Real-time WebSocket communication between client and server
- Tile-based world system with 20x20 grid
- Camera system that follows player movement
- Basic player movement with WASD/arrow key controls
- SQLite database with SQLAlchemy ORM for data persistence
- Admin functionality for world management

### Technical
- Python FastAPI backend server
- HTML5 Canvas client with vanilla JavaScript
- WebSocket-based real-time communication
- JWT-based authentication system
- SQLite database for user and world state storage

---

## Development Notes

### Architecture
- **Server**: Python FastAPI with WebSockets for real-time communication
- **Client**: HTML5 Canvas with vanilla JavaScript
- **Database**: SQLite with SQLAlchemy ORM
- **Authentication**: JWT-based user authentication

### Game Design
- Turn-based gameplay with 2-second ticks
- Server-authoritative design prevents cheating
- Tile-based world with grid movement
- Class-based character progression system
- Resource gathering and combat mechanics

### Planned Features
- Additional character classes (Knight, Archer)
- Crafting system using gathered resources  
- Player vs Player combat
- Guild system and team mechanics
- Expanded world with multiple zones
- Quest and mission system
- Trading between players

For more details and development updates, visit the [GitHub Repository](https://github.com/otaviokmkm/TheChessMMORPG).
