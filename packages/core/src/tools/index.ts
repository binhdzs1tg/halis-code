import type { Tool } from '../types.js'
import { bashTool } from './bash.js'
import { readTool } from './read.js'
import { writeTool } from './write.js'
import { editTool } from './edit.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { lsTool } from './ls.js'
import { webFetchTool } from './web-fetch.js'
import { webSearchTool } from './web-search.js'
import { todoTool } from './todo.js'
import { skillTool } from './skill.js'
import { askUserTool } from './ask-user.js'
import { jobKillTool, jobOutputTool } from './jobs.js'
import { createTaskTool, type TaskShared } from './task.js'

export function defaultTools(): Tool[] {
  return [
    bashTool,
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    lsTool,
    webFetchTool,
    webSearchTool,
    todoTool,
    skillTool,
    askUserTool,
    jobOutputTool,
    jobKillTool,
  ]
}

/** The task tool needs the parent run's provider and toolset, so it binds
 *  late — call this after the tools list is otherwise complete. */
export function withTaskTool(tools: Tool[], shared: TaskShared): Tool[] {
  return [...tools, createTaskTool({ ...shared, tools })]
}
