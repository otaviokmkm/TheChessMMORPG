from sqlalchemy import Column, Integer, String, Text
from .db import Base
import json

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    # TODO: Re-add XP persistence after database migration
    # class_xp = Column(Text, default="{}")
    
    def get_class_xp(self) -> dict:
        """Get class XP as a dictionary."""
        # TODO: Re-enable after database migration
        return {}
        # try:
        #     return json.loads(self.class_xp or "{}")
        # except json.JSONDecodeError:
        #     return {}
    
    def set_class_xp(self, xp_dict: dict):
        """Set class XP from a dictionary."""
        # TODO: Re-enable after database migration
        pass
        # self.class_xp = json.dumps(xp_dict or {})

