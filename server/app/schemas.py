from pydantic import BaseModel, Field
from typing import Literal, Optional

class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"

class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=6, max_length=128)

class UserOut(BaseModel):
    id: int
    username: str
    is_admin: bool = False

class ClientHello(BaseModel):
    token: str
    client: str = "web"

class Move(BaseModel):
    dx: int
    dy: int

class ActionMessage(BaseModel):
    type: Literal["move", "rest", "talk", "choose_class", "cast", "gather", "chat"]
    payload: Optional[dict] = None
