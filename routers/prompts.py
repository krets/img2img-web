from fastapi import APIRouter, HTTPException

import db
from models import PromptIn, PromptUpdateIn

router = APIRouter(prefix="/api/prompts", tags=["prompts"])


@router.get("")
def list_prompts():
    return db.list_prompts()


@router.post("")
def create_prompt(body: PromptIn):
    return db.create_prompt(body.title, body.prompt_text)


@router.put("/{prompt_id}")
def update_prompt(prompt_id: str, body: PromptUpdateIn):
    if not db.get_prompt(prompt_id):
        raise HTTPException(404, "Prompt not found")
    return db.update_prompt(prompt_id, title=body.title, prompt_text=body.prompt_text)


@router.delete("/{prompt_id}")
def delete_prompt(prompt_id: str):
    if not db.get_prompt(prompt_id):
        raise HTTPException(404, "Prompt not found")
    db.delete_prompt(prompt_id)
    return {"ok": True}
