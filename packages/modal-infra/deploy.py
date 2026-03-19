#!/usr/bin/env python3
"""
Deployment entry point for Open-Inspect Modal app.

This file imports all modules to register their functions with the app.
Run with: modal deploy deploy.py
"""

import sys
from pathlib import Path

repo_dir = Path(__file__).parent

# Add local source roots needed during Modal's import-time app discovery.
sys.path.insert(0, str(repo_dir / "src"))
sys.path.insert(0, str(repo_dir.parent / "sandbox-runtime" / "src"))

# Import the app and all modules that register Modal functions/endpoints.
# Modal only discovers decorated functions from imported modules during deploy.
from src.app import app
from src import functions as _functions  # noqa: F401
from src import web_api as _web_api  # noqa: F401

# Re-export the app for Modal
__all__ = ["app"]
