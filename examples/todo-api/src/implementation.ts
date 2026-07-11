import type { TodoOperations, Todo, CreateTodoOutput, GetTodoOutput, ListTodosOutput } from '../generated/todo.gen'
import { TodoNotFound } from '../generated/todo.gen'

const store = new Map<string, Todo>()

export const todoOps: TodoOperations = {
  async CreateTodo({ body }) {
    const todo: Todo = {
      id: crypto.randomUUID(),
      title: body.title,
      done: body.done ?? false,
      createdAt: new Date().toISOString(),
    }
    store.set(todo.id, todo)
    return { item: todo } satisfies CreateTodoOutput
  },

  async GetTodo({ id }) {
    const todo = store.get(id)
    if (!todo) throw new TodoNotFound(`Todo ${id} not found`)
    return { item: todo } satisfies GetTodoOutput
  },

  async ListTodos({ nextToken }) {
    const all = [...store.values()]
    const startIndex = nextToken ? all.findIndex(t => t.id === nextToken) : 0
    const page = all.slice(startIndex < 0 ? 0 : startIndex, startIndex + 20)
    const last = page.at(-1)
    return {
      items: page,
      nextToken: last && store.size > startIndex + 20 ? last.id : undefined,
    } satisfies ListTodosOutput
  },

  async DeleteTodo({ id }) {
    if (!store.has(id)) throw new TodoNotFound(`Todo ${id} not found`)
    store.delete(id)
  },
}
