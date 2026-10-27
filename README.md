# dti-ai-cx-brick
### Project: AI-CX — Proof-of-Concept: AI-assisteret og automatiseret semantisk integration af bygningsdata til commissioning og bygningsdrift

This repository contains a proof of concept human-in-the-loop agentic workflow that maps building data and documentation to a validated [Brick Ontology](https://brickschema.org/) model, to support continuous commissioning developed by the Danish Technological Institute (DTI), within an Energy Cluster Denmark project.

Discover the workflow on an interactive page here: ??

Each BMS vendor and contractor names and structures points differently, so the same sensor may appear differently from building to building. The workflow takes the data a building already has, in example: point lists, time-series objects, BACnet exports, contractor documentation and screenshots of the BMS. It leverages the contents and translates these into a standard semantic model (using the Brick and RealEstateCore ontologies) that can subsequently be used for commissioning, fault detection, energy analytics, benchmarking and more across a building portfolio. AI agent skills interpret the material: they decode naming conventions and abbreviations, and extract equipment and system connections from the screenshots. Deterministic tools validate, classify and generate the model and a person confirms the AI’s proposals at defined checkpoints.

![Project Design Diagram](images/design.png)
