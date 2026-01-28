import { Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { EventType } from '../types/index.js';
import { LoggerService } from '../logger/logger.service.js';

/** Event structure for storage */
export interface StoredEvent {
  id: string;
  type: EventType;
  timestamp: string;
  source: string;
  payload: Record<string, unknown>;
}

const EVENT_DIRS = {
  base: process.env.EVENT_DIR || '/home/claude/data/orchestrator-events',
  get pending() { return path.join(this.base, 'pending'); },
  get processed() { return path.join(this.base, 'processed'); },
};

@Injectable()
export class EventService implements OnModuleInit {
  constructor(private readonly logger: LoggerService) {}

  onModuleInit(): void {
    this.ensureDirectories();
    this.logger.info('events', 'Event service initialized');
  }

  private ensureDirectories(): void {
    fs.mkdirSync(EVENT_DIRS.pending, { recursive: true });
    fs.mkdirSync(EVENT_DIRS.processed, { recursive: true });
  }

  createEvent(
    type: EventType,
    payload: Record<string, unknown>,
    source: string,
  ): StoredEvent {
    const timestamp = new Date().toISOString();
    const id = uuidv4();

    const event: StoredEvent = {
      id,
      type,
      timestamp,
      source,
      payload,
    };

    const filename = `${timestamp.replace(/[:.]/g, '-')}-${type.replace(/\./g, '-')}-${id.slice(0, 8)}.json`;
    const filepath = path.join(EVENT_DIRS.pending, filename);

    fs.writeFileSync(filepath, JSON.stringify(event, null, 2));

    this.logger.info('events', `Created event: ${type} (${id.slice(0, 8)})`);
    return event;
  }

  getPendingEvents(): StoredEvent[] {
    const files = fs.readdirSync(EVENT_DIRS.pending)
      .filter(f => f.endsWith('.json'))
      .sort();

    return files.map(filename => {
      const filepath = path.join(EVENT_DIRS.pending, filename);
      const content = fs.readFileSync(filepath, 'utf8');
      return JSON.parse(content) as StoredEvent;
    });
  }

  getPendingEvent(eventId: string): StoredEvent | null {
    const files = fs.readdirSync(EVENT_DIRS.pending)
      .filter(f => f.includes(eventId.slice(0, 8)));

    if (files.length === 0) return null;

    const filepath = path.join(EVENT_DIRS.pending, files[0]);
    const content = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(content) as StoredEvent;
  }

  markProcessed(eventId: string): boolean {
    const files = fs.readdirSync(EVENT_DIRS.pending)
      .filter(f => f.includes(eventId.slice(0, 8)));

    if (files.length === 0) {
      this.logger.warn('events', `Event ${eventId} not found in pending`);
      return false;
    }

    const filename = files[0];
    const sourcePath = path.join(EVENT_DIRS.pending, filename);
    const destPath = path.join(EVENT_DIRS.processed, filename);

    fs.renameSync(sourcePath, destPath);
    this.logger.info('events', `Marked event as processed: ${eventId.slice(0, 8)}`);
    return true;
  }

  getProcessedEvents(limit?: number): StoredEvent[] {
    let files = fs.readdirSync(EVENT_DIRS.processed)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();

    if (limit) {
      files = files.slice(0, limit);
    }

    return files.map(filename => {
      const filepath = path.join(EVENT_DIRS.processed, filename);
      const content = fs.readFileSync(filepath, 'utf8');
      return JSON.parse(content) as StoredEvent;
    });
  }

  getAllEvents(limit?: number): StoredEvent[] {
    const pending = this.getPendingEvents();
    const processed = this.getProcessedEvents(limit ? limit - pending.length : undefined);

    return [...pending, ...processed]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  getEventDirs(): typeof EVENT_DIRS {
    return EVENT_DIRS;
  }
}
