import { Runner, getQuaranTabInstance } from '@src/lib/quarantab'
import Daemon from './Daemon'

const daemon = new Daemon(browser, getQuaranTabInstance(Runner.BACKGROUND))
daemon.run()
