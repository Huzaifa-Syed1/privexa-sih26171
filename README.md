# Privexa — Privacy-First Autonomous Browser Agent

> **Let AI operate your browser — without giving AI your private data.**

[![SIH 2026](https://img.shields.io/badge/Smart%20India%20Hackathon-2026-blueviolet)](https://www.sih.gov.in/)
[![Problem Statement](https://img.shields.io/badge/PS-SIH26171-blue)](#)
[![Platform](https://img.shields.io/badge/Platform-Chrome-orange)](#)
[![Backend](https://img.shields.io/badge/Backend-FastAPI-009688)](#)
[![AI](https://img.shields.io/badge/AI-Gemini-blue)](#)

**Privexa** is a privacy-first autonomous browser agent designed to let AI understand and operate websites while keeping sensitive user information on the user's device.

Instead of sending raw HTML, screenshots, passwords, email addresses, phone numbers, or other private information to a remote AI model, Privexa performs perception and sensitive-data handling locally and sends the planner only a **sanitized scene graph**.

---

## Table of Contents

- [What is Privexa?](#what-is-privexa)
- [Problem](#problem)
- [Solution](#solution)
- [Why Privexa is Different](#why-privexa-is-different)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Key Features](#key-features)
- [Privexa 2.0 Upgrades](#privexa-20-upgrades)
- [Privacy Boundary](#privacy-boundary)
- [Project Structure](#project-structure)
- [Requirements](#requirements)
- [Installation](#installation)
- [Running the Backend](#running-the-backend)
- [Loading the Chrome Extension](#loading-the-chrome-extension)
- [Running the Demo](#running-the-demo)
- [Configuration](#configuration)
- [Security Model](#security-model)
- [Testing](#testing)
- [Known Limitations](#known-limitations)
- [Future Improvements](#future-improvements)
- [Team / Hackathon](#team--hackathon)

---

# What is Privexa?

Modern browser agents can perform useful tasks such as:

- filling forms
- navigating websites
- clicking buttons
- searching for information
- completing repetitive workflows
- interacting with dynamic web applications

The problem is that conventional browser agents may expose large amounts of private webpage data to a remote model.

Privexa changes this architecture.

### Core principle

> **The AI decides what to do, but the device controls what the AI is allowed to see and what it is allowed to execute.**

Privexa separates:

**Perception + Privacy + Execution**

from

**Remote AI Planning**

This creates a local privacy boundary around the user's sensitive information.

---

# Problem

A browser agent may need to interact with information such as:

- email addresses
- passwords
- phone numbers
- payment information
- personal identifiers
- private webpage text
- images containing sensitive information

Sending this information directly to an external AI system creates an unnecessary privacy risk.

Privexa is designed around the question:

> **Can an AI agent operate the browser without receiving the user's secrets?**

---

# Solution

Privexa uses a layered architecture:

```text
                    USER GOAL
                       │
                       ▼
              ┌─────────────────┐
              │  Local Browser  │
              │    Perception   │
              └────────┬────────┘
                       │
             ┌─────────┴─────────┐
             │                   │
             ▼                   ▼
       DOM Extraction       Local Vision/OCR
             │                   │
             └─────────┬─────────┘
                       ▼
                PII REDACTION
                       │
                       ▼
              SANITIZED SCENE GRAPH
                       │
                 NETWORK BOUNDARY
                       │
                       ▼
                REMOTE AI PLANNER
                       │
                 SAFE ACTION
                       │
                       ▼
             LOCAL ACTION VALIDATION
                       │
                       ▼
               LOCAL EXECUTION
                       │
                       ▼
                  RE-OBSERVE
                       │
                       └──────► RE-PLAN
