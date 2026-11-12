import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('users', (table) => {
      table.increments('id')
      table.string('email').notNullable().unique()
      table.string('full_name').nullable()
      table.string('password').notNullable()
      table.string('role').notNullable().defaultTo('customer')
      table.string('plan').notNullable().defaultTo('free')
    })
  }

  async down() {
    this.schema.dropTable('users')
  }
}
