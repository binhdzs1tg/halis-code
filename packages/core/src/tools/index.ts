import type { Tool } from '../types.js'
import { bashTool } from './bash.js'
import { readTool } from './read.js'
import { writeTool } from './write.js'
import { editTool } from './edit.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { lsTool } from './ls.js'

export function defaultTools(): Tool[] {
  return [bashTool, readTool, writeTool, editTool, globTool, grepTool, lsTool]
}
